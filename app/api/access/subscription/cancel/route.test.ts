// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancel = vi.fn();
const checkLimit = vi.fn();
const recordAttempt = vi.fn();

vi.mock("@/lib/commercial-cancel", () => ({ cancelOwnSubscription: (t: string) => cancel(t) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkIntakeRateLimit: (...a: unknown[]) => checkLimit(...a),
    recordIntakeAttempt: (...a: unknown[]) => recordAttempt(...a),
  };
});

import { GET, POST } from "./route";

const TOKEN = "Zk3_-" + "A".repeat(38);
const ERROR = "/access/subscription-cancelled?status=error";

function formRequest(fields: Record<string, string> = { t: TOKEN, confirm: "on" }, headers: Record<string, string> = {}): Request {
  return new Request("https://www.compute-atlas.com/api/access/subscription/cancel", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });
}

function expectError(res: Response) {
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toContain("no-store");
  const loc = new URL(res.headers.get("location") ?? "");
  expect(loc.pathname + loc.search).toBe(ERROR);
  expect(res.headers.get("location")).not.toContain(TOKEN);
}

beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  checkLimit.mockResolvedValue({ ok: true });
  recordAttempt.mockResolvedValue(undefined);
  cancel.mockResolvedValue({ ok: true, paidThrough: new Date("2026-12-15T12:00:00Z") });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/access/subscription/cancel", () => {
  it.each([["COMMERCIAL_TIER_ENABLED"], ["DATASET_SHARING_ENABLED"]])("is 403 with %s off and does no work", async (name) => {
    vi.stubEnv(name, "");
    const res = await POST(formRequest());
    expect(res.status).toBe(403);
    expect(checkLimit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([["cross-site"], ["same-site"]])("refuses sec-fetch-site %s before any rate-limit or PayPal work", async (site) => {
    expectError(await POST(formRequest(undefined, { "sec-fetch-site": site })));
    expect(checkLimit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([["https://evil.example"], ["null"]])("refuses a foreign or opaque Origin (%s) before any work", async (origin) => {
    expectError(await POST(formRequest(undefined, { origin })));
    expect(checkLimit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("accepts the request's own Origin", async () => {
    const res = await POST(formRequest(undefined, { origin: "https://www.compute-atlas.com" }));
    expect(new URL(res.headers.get("location") ?? "").search).toBe("?status=cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rate-limits on commercial-billing-portal, gating before recording", async () => {
    await POST(formRequest());
    expect(checkLimit.mock.calls[0][0]).toBe("commercial-billing-portal");
    expect(recordAttempt.mock.calls[0][0]).toBe("commercial-billing-portal");
    expect(checkLimit.mock.invocationCallOrder[0]).toBeLessThan(recordAttempt.mock.invocationCallOrder[0]);
    expect(recordAttempt.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
  });

  it("fails closed when over the limit", async () => {
    checkLimit.mockResolvedValue({ ok: false });
    expectError(await POST(formRequest()));
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("fails closed when rate-limit accounting throws", async () => {
    checkLimit.mockRejectedValue(new Error("db down"));
    expectError(await POST(formRequest()));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records the attempt even when the body is bad", async () => {
    expectError(await POST(formRequest({ confirm: "on" })));
    expect(recordAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing token", { confirm: "on" }],
    ["malformed token", { t: "short", confirm: "on" }],
    ["missing confirm", { t: TOKEN }],
    ["confirm not on", { t: TOKEN, confirm: "off" }],
  ])("%s -> the generic error, PayPal never called", async (_n, fields) => {
    expectError(await POST(formRequest(fields)));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a non-form body is the generic error", async () => {
    const req = new Request("https://www.compute-atlas.com/api/access/subscription/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expectError(await POST(req));
  });

  it("an ineligible grant is the SAME generic error", async () => {
    cancel.mockResolvedValue({ ok: false });
    expectError(await POST(formRequest()));
  });

  it("success is a no-store 303 to the token-free result page with no date", async () => {
    const res = await POST(formRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname + loc.search).toBe("/access/subscription-cancelled?status=cancelled");
    expect(res.headers.get("location")).not.toContain(TOKEN);
    expect(res.headers.get("location")).not.toContain("through");
    expect(cancel).toHaveBeenCalledWith(TOKEN);
  });

  it("GET is a no-store 405", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
