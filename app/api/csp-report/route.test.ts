import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

import {
  CSP_REPORT_LIMIT_MAX,
  MAX_CSP_REPORT_BYTES,
  __resetCspReportRateLimit,
} from "@/lib/csp-report";

import { POST } from "./route";

/**
 * The endpoint is unauthenticated by necessity (browsers send these, not the
 * app), so its contract is mostly about what it REFUSES to do: no unbounded
 * body, no unbounded log volume from one caller, no crash on hostile input,
 * and no logging of extension noise that would bury a real finding.
 *
 * Every "is logged" assertion here reads `console.warn`, because logging is
 * the endpoint's entire observable output — it returns the same 204 whether
 * it recorded a violation or dropped it, deliberately, so asserting on the
 * status code alone would pass for an endpoint that silently discarded
 * everything.
 */

/** A well-formed `report-uri` payload, with an overridable inner report. */
function reportBody(overrides: Record<string, unknown> = {}) {
  return {
    "csp-report": {
      "document-uri": "https://www.compute-atlas.com/map?state=CA",
      referrer: "",
      "violated-directive": "script-src",
      "effective-directive": "script-src-elem",
      "original-policy": "default-src 'self'; script-src 'self'",
      disposition: "enforce",
      "blocked-uri": "https://evil.example.com/x.js",
      "line-number": 42,
      "column-number": 7,
      "source-file": "https://www.compute-atlas.com/_next/static/chunks/main.js",
      "status-code": 200,
      "script-sample": "",
      ...overrides,
    },
  };
}

function req(body: unknown, init: { ip?: string; raw?: string } = {}): Request {
  const payload = init.raw ?? JSON.stringify(body);
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: {
      "content-type": "application/csp-report",
      // The route buckets on the trusted-IP precedence in lib/rate-limit.ts,
      // where `x-real-ip` is the non-Cloudflare fallback. Distinct per test
      // so one case's budget can't leak into another's.
      "x-real-ip": init.ip ?? "203.0.113.7",
    },
    body: payload,
  });
}

/** The parsed `console.warn` payloads this request produced. */
function loggedEvents(spy: MockInstance<typeof console.warn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  __resetCspReportRateLimit();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("POST /api/csp-report", () => {
  it("accepts a report-uri payload and logs the violation", async () => {
    const res = await POST(req(reportBody()));

    expect(res.status).toBe(204);
    const events = loggedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "csp-violation",
      directive: "script-src-elem",
      blocked: "https://evil.example.com/x.js",
      line: 42,
    });
  });

  it("records the path but not the query string of the offending document", async () => {
    await POST(req(reportBody()));

    const [event] = loggedEvents(warn);
    expect(event.path).toBe("/map");
    expect(JSON.stringify(event)).not.toContain("state=CA");
  });

  it("accepts the Reporting-API array form as well", async () => {
    const res = await POST(
      req([
        {
          type: "csp-violation",
          url: "https://www.compute-atlas.com/table",
          body: {
            documentURL: "https://www.compute-atlas.com/table",
            effectiveDirective: "img-src",
            blockedURL: "https://cdn.example.com/pixel.gif",
            disposition: "enforce",
            lineNumber: 1,
          },
        },
      ])
    );

    expect(res.status).toBe(204);
    expect(loggedEvents(warn)[0]).toMatchObject({
      path: "/table",
      directive: "img-src",
      blocked: "https://cdn.example.com/pixel.gif",
    });
  });

  it("ignores non-CSP entries in a Reporting-API batch", async () => {
    const res = await POST(
      req([{ type: "deprecation", url: "https://www.compute-atlas.com/", body: { id: "x" } }])
    );

    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  describe("noise filtering", () => {
    /**
     * Extension-injected scripts are the dominant source of CSP reports on
     * any public site. If they were logged, the one report that matters —
     * a real subresource the enforcing policy is now blocking for actual
     * visitors — would be unfindable underneath them.
     */
    it.each([
      ["chrome-extension://abcdef/inject.js"],
      ["moz-extension://abcdef/inject.js"],
      ["safari-web-extension://abcdef/inject.js"],
    ])("drops a violation blocked on %s", async (blocked) => {
      const res = await POST(req(reportBody({ "blocked-uri": blocked })));

      expect(res.status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    });

    it("drops a violation whose SOURCE is an extension even when the blocked URI is not", async () => {
      await POST(
        req(
          reportBody({
            "blocked-uri": "https://evil.example.com/x.js",
            "source-file": "chrome-extension://abcdef/inject.js",
          })
        )
      );

      expect(warn).not.toHaveBeenCalled();
    });

    it("drops the non-actionable bare blocked-uri values browsers emit", async () => {
      for (const blocked of ["about", "asset", "invalid", "null", ""]) {
        await POST(req(reportBody({ "blocked-uri": blocked })));
      }

      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * The filter matches scheme prefixes and whole values, never substrings —
     * a host that merely CONTAINS a filtered word is a real report.
     */
    it("keeps a real violation from a host containing a filtered word", async () => {
      await POST(req(reportBody({ "blocked-uri": "https://about.example.com/x.js" })));

      expect(loggedEvents(warn)[0]).toMatchObject({
        blocked: "https://about.example.com/x.js",
      });
    });
  });

  describe("abuse bounds", () => {
    it("rejects a body larger than the cap without parsing it", async () => {
      const oversized = JSON.stringify({
        "csp-report": { "blocked-uri": "x".repeat(MAX_CSP_REPORT_BYTES) },
      });

      const res = await POST(req(null, { raw: oversized }));

      expect(res.status).toBe(413);
      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * `content-length` is caller-supplied. A body that under-declares its
     * size must still be rejected on its real decoded length, or the header
     * check would be the bound rather than an optimisation.
     */
    it("rejects an oversized body that lies about its content-length", async () => {
      const oversized = "y".repeat(MAX_CSP_REPORT_BYTES + 1);
      const request = new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-length": "10", "x-real-ip": "203.0.113.9" },
        body: oversized,
      });

      expect((await POST(request)).status).toBe(413);
    });

    it("rejects malformed JSON without throwing", async () => {
      const res = await POST(req(null, { raw: "{not json" }));

      expect(res.status).toBe(400);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([["null"], ['"a string"'], ["[]"], ["{}"], ['{"csp-report":"nope"}']])(
      "returns 204 and logs nothing for the unrecognised payload %s",
      async (raw) => {
        const res = await POST(req(null, { raw }));

        expect(res.status).toBe(204);
        expect(warn).not.toHaveBeenCalled();
      }
    );

    it("caps how many reports one request can log", async () => {
      const batch = Array.from({ length: 50 }, () => ({
        type: "csp-violation",
        body: {
          documentURL: "https://www.compute-atlas.com/",
          effectiveDirective: "img-src",
          blockedURL: "https://cdn.example.com/pixel.gif",
        },
      }));

      await POST(req(batch));

      expect(warn.mock.calls.length).toBeLessThanOrEqual(10);
    });

    it("rate-limits one IP past the per-window cap", async () => {
      for (let i = 0; i < CSP_REPORT_LIMIT_MAX; i++) {
        expect((await POST(req(reportBody(), { ip: "198.51.100.4" }))).status).toBe(204);
      }

      const blocked = await POST(req(reportBody(), { ip: "198.51.100.4" }));
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
    });

    it("does not spend one IP's budget on another's reports", async () => {
      for (let i = 0; i < CSP_REPORT_LIMIT_MAX; i++) {
        await POST(req(reportBody(), { ip: "198.51.100.4" }));
      }

      expect((await POST(req(reportBody(), { ip: "198.51.100.5" }))).status).toBe(204);
    });
  });
});
