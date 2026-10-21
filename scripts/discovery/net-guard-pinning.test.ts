// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkSources } from "./check-sources";
import { fetchPageText } from "./fetch-page-text";
import {
  SSRF_BLOCKED_CODE,
  createGuardedLookup,
  createPinnedFetch,
  isSsrfBlockedError,
  type ResolveDeps,
} from "./net-guard";
import type { Facility } from "../../lib/schema";

type LookupResult = { err: Error | null; address?: unknown; family?: number };

function runLookup(
  deps: ResolveDeps,
  hostname: string,
  options: Parameters<ReturnType<typeof createGuardedLookup>>[1] = {},
): Promise<LookupResult> {
  return new Promise((resolve) => {
    createGuardedLookup(deps)(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

const PUBLIC4 = "93.184.216.34";
const PUBLIC6 = "2606:2800:220:1:248:1893:25c8:1946";

describe("createGuardedLookup", () => {
  it("refuses a hostname that resolves to a blocked IPv4 address", async () => {
    const r = await runLookup({ resolve4: async () => ["127.0.0.1"], resolve6: async () => [] }, "evil.test");
    expect((r.err as { code?: string }).code).toBe(SSRF_BLOCKED_CODE);
  });

  it("refuses a hostname that resolves to a blocked IPv6 address", async () => {
    const r = await runLookup({ resolve4: async () => [], resolve6: async () => ["::1"] }, "evil.test");
    expect((r.err as { code?: string }).code).toBe(SSRF_BLOCKED_CODE);
  });

  it("refuses when ANY address is blocked (mixed public + private)", async () => {
    const r = await runLookup(
      { resolve4: async () => [PUBLIC4, "10.0.0.5"], resolve6: async () => [] },
      "evil.test",
      { all: true },
    );
    expect((r.err as { code?: string }).code).toBe(SSRF_BLOCKED_CODE);
  });

  it("refuses a blocked hostname without resolving", async () => {
    const resolve4 = vi.fn(async () => [PUBLIC4]);
    const r = await runLookup({ resolve4, resolve6: async () => [] }, "localhost");
    expect((r.err as { code?: string }).code).toBe(SSRF_BLOCKED_CODE);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("returns a single address (v4 first) when all is false", async () => {
    const r = await runLookup({ resolve4: async () => [PUBLIC4], resolve6: async () => [PUBLIC6] }, "ok.test");
    expect(r).toEqual({ err: null, address: PUBLIC4, family: 4 });
  });

  it("returns every address, v4 before v6, when all is true", async () => {
    const r = await runLookup({ resolve4: async () => [PUBLIC4], resolve6: async () => [PUBLIC6] }, "ok.test", {
      all: true,
    });
    expect(r.address).toEqual([
      { address: PUBLIC4, family: 4 },
      { address: PUBLIC6, family: 6 },
    ]);
  });

  it("honours the family filter", async () => {
    const deps = { resolve4: async () => [PUBLIC4], resolve6: async () => [PUBLIC6] };
    expect(await runLookup(deps, "ok.test", { family: 6 })).toEqual({ err: null, address: PUBLIC6, family: 6 });
    expect(await runLookup(deps, "ok.test", 4)).toEqual({ err: null, address: PUBLIC4, family: 4 });
  });

  it("preserves the original ENOTFOUND error when both families fail", async () => {
    const original = Object.assign(new Error("queryA ENOTFOUND gone.test"), { code: "ENOTFOUND" });
    const r = await runLookup(
      {
        resolve4: async () => {
          throw original;
        },
        resolve6: async () => {
          throw new Error("other");
        },
      },
      "gone.test",
    );
    expect(r.err).toBe(original);
  });

  it("reports ENOTFOUND when no addresses come back at all", async () => {
    const r = await runLookup({ resolve4: async () => [], resolve6: async () => [] }, "empty.test");
    expect((r.err as { code?: string }).code).toBe("ENOTFOUND");
  });
});

describe("createGuardedLookup callback discipline", () => {
  const paths: Array<[string, ResolveDeps, string]> = [
    ["success", { resolve4: async () => [PUBLIC4], resolve6: async () => [] }, "ok.test"],
    ["blocked", { resolve4: async () => ["10.0.0.1"], resolve6: async () => [] }, "evil.test"],
    ["not found", { resolve4: async () => [], resolve6: async () => [] }, "gone.test"],
    [
      "resolver throws synchronously",
      {
        resolve4: () => {
          throw new Error("boom");
        },
        resolve6: async () => [],
      },
      "boom.test",
    ],
  ];

  it.each(paths)("invokes the callback exactly once on the %s path", async (_name, deps, host) => {
    const cb = vi.fn();
    createGuardedLookup(deps)(host, {}, cb);
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a throwing callback surfaces as an uncaught exception, like dns.lookup, never an unhandled rejection", async () => {
    const cb = vi.fn(() => {
      throw new Error("callback bug");
    });
    const uncaught = vi.fn();
    const unhandled = vi.fn();
    // Vitest installs its own handlers; take them over for the duration of this test.
    const savedUncaught = process.listeners("uncaughtException");
    const savedUnhandled = process.listeners("unhandledRejection");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    process.on("uncaughtException", uncaught);
    process.on("unhandledRejection", unhandled);
    try {
      createGuardedLookup({ resolve4: async () => [PUBLIC4], resolve6: async () => [] })("ok.test", {}, cb);
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
      savedUncaught.forEach((l) => process.on("uncaughtException", l));
      savedUnhandled.forEach((l) => process.on("unhandledRejection", l));
    }
    expect(cb).toHaveBeenCalledTimes(1);
    expect(uncaught).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("createPinnedFetch memoization", () => {
  it("returns the same fetch (one Agent) for the same deps object, distinct for others", () => {
    const deps: ResolveDeps = { resolve4: async () => [PUBLIC4], resolve6: async () => [] };
    expect(createPinnedFetch(deps)).toBe(createPinnedFetch(deps));
    expect(createPinnedFetch({ ...deps })).not.toBe(createPinnedFetch(deps));
  });
});

describe("isSsrfBlockedError", () => {
  it("matches the code on the error or its cause only", () => {
    expect(isSsrfBlockedError({ code: SSRF_BLOCKED_CODE })).toBe(true);
    expect(isSsrfBlockedError({ cause: { code: SSRF_BLOCKED_CODE } })).toBe(true);
    expect(isSsrfBlockedError({ cause: { code: "ENOTFOUND" } })).toBe(false);
    expect(isSsrfBlockedError(null)).toBe(false);
  });
});

// DNS rebinding: public answer for the pre-check, loopback for the connect.
describe("DNS rebinding regression (no external network)", () => {
  let server: Server;
  let port: number;
  let connections: number;

  beforeEach(async () => {
    connections = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>secret</body></html>");
    });
    server.on("connection", () => {
      connections++;
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function rebindingDeps(): ResolveDeps {
    let calls = 0;
    return {
      resolve4: async () => (++calls === 1 ? [PUBLIC4] : ["127.0.0.1"]),
      resolve6: async () => [],
    };
  }

  it("fetchPageText refuses a connection rebound to loopback after the pre-check", async () => {
    const result = await fetchPageText(`http://rebind.test:${port}/`, { resolveDeps: rebindingDeps() });
    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect(connections).toBe(0);
  });

  it("checkSources classifies a host rebound to loopback after the pre-check as blocked", async () => {
    const facility = {
      id: "f",
      name: "F",
      sources: [{ url: `http://rebind.test:${port}/`, title: "t", retrievedAt: "2026-01-01" }],
    } as unknown as Facility;
    const [row] = await checkSources([facility], { concurrency: 1, timeoutMs: 2000, resolveDeps: rebindingDeps() });
    expect(row.classification).toBe("blocked");
    expect(connections).toBe(0);
  });

  it("does not retry a blocked connection", async () => {
    let calls = 0;
    const deps: ResolveDeps = {
      resolve4: async () => (++calls === 1 ? [PUBLIC4] : ["127.0.0.1"]),
      resolve6: async () => [],
    };
    const sleepImpl = vi.fn(async () => {});
    const facility = {
      id: "f",
      name: "F",
      sources: [{ url: `http://rebind.test:${port}/`, title: "t", retrievedAt: "2026-01-01" }],
    } as unknown as Facility;
    await checkSources([facility], { concurrency: 1, timeoutMs: 2000, resolveDeps: deps, sleepImpl });
    expect(sleepImpl).not.toHaveBeenCalled();
    // pre-check + exactly one connect-time lookup
    expect(calls).toBe(2);
  });
});
