// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createPortal = vi.fn();
const checkLimit = vi.fn();
const recordAttempt = vi.fn();
const getGrant = vi.fn();
const getCustomer = vi.fn();

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, createBillingPortalSession: (a: unknown) => createPortal(a) };
});
vi.mock("@/lib/dataset-grants", () => ({
  getGrantByAccessToken: (t: string) => getGrant(t),
  getBillingCustomerId: (id: string) => getCustomer(id),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkIntakeRateLimit: (...a: unknown[]) => checkLimit(...a),
    recordIntakeAttempt: (...a: unknown[]) => recordAttempt(...a),
  };
});

import { StripeConfigError } from "@/lib/stripe";
import { GET, POST } from "./route";

const TOKEN = "Zk3_-" + "A".repeat(38);
const PORTAL_URL = "https://billing.stripe.com/p/session/test_abc";
const UNAVAILABLE = "/access/billing-return?status=unavailable";

const grant = (tier: "free" | "commercial") => ({
  state: "active" as const,
  grant: { id: "g1", name: "Pat", organization: null, expiresAt: new Date("2027-01-01"), tier, hasBillingAccount: true },
});

function formRequest(t: string | null = TOKEN, headers: Record<string, string> = {}): Request {
  return new Request("https://www.compute-atlas.com/api/access/billing-portal", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(t === null ? {} : { t }),
  });
}

function expectUnavailable(res: Response) {
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toContain("no-store");
  const loc = new URL(res.headers.get("location") ?? "");
  expect(loc.pathname + loc.search).toBe(UNAVAILABLE);
  expect(res.headers.get("location")).not.toContain(TOKEN);
}

beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  checkLimit.mockResolvedValue({ ok: true });
  recordAttempt.mockResolvedValue(undefined);
  getGrant.mockResolvedValue(grant("commercial"));
  getCustomer.mockResolvedValue("cus_123");
  createPortal.mockResolvedValue(PORTAL_URL);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/access/billing-portal", () => {
  it.each([["COMMERCIAL_TIER_ENABLED"], ["DATASET_SHARING_ENABLED"]])("is 403 with %s off and does no work", async (name) => {
    vi.stubEnv(name, "");
    const res = await POST(formRequest());
    expect(res.status).toBe(403);
    expect(checkLimit).not.toHaveBeenCalled();
    expect(getGrant).not.toHaveBeenCalled();
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("answers GET with a no-store 405", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses a cross-site POST before any rate-limit, DB or Stripe work", async () => {
    const res = await POST(formRequest(TOKEN, { "sec-fetch-site": "cross-site" }));
    expectUnavailable(res);
    expect(checkLimit).not.toHaveBeenCalled();
    expect(getGrant).not.toHaveBeenCalled();
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("redirects to unavailable when rate limited, without lookups", async () => {
    checkLimit.mockResolvedValue({ ok: false });
    expectUnavailable(await POST(formRequest()));
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(getGrant).not.toHaveBeenCalled();
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("fails closed with a redacted log when rate-limit accounting throws", async () => {
    checkLimit.mockRejectedValue(Object.assign(new Error("Failed query: params: ip-hash"), { code: "08006" }));
    expectUnavailable(await POST(formRequest()));
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain("ip-hash");
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("uses the commercial-billing-portal surface, recording the attempt", async () => {
    await POST(formRequest());
    expect(checkLimit).toHaveBeenCalledWith("commercial-billing-portal", expect.any(String));
    expect(recordAttempt).toHaveBeenCalledWith("commercial-billing-portal", expect.any(String));
  });

  it("checks and records the rate limit before it reads the body", async () => {
    const req = formRequest();
    const formData = vi.fn().mockRejectedValue(new Error("body read failed"));
    req.formData = formData;
    expectUnavailable(await POST(req));
    expect(checkLimit).toHaveBeenCalledTimes(1);
    expect(recordAttempt).toHaveBeenCalledTimes(1);
    expect(formData).toHaveBeenCalledTimes(1);
    const body = formData.mock.invocationCallOrder[0];
    expect(checkLimit.mock.invocationCallOrder[0]).toBeLessThan(body);
    expect(recordAttempt.mock.invocationCallOrder[0]).toBeLessThan(body);
    expect(getGrant).not.toHaveBeenCalled();
  });

  it("never reads the body when rate limited", async () => {
    checkLimit.mockResolvedValue({ ok: false });
    const req = formRequest();
    const formData = vi.fn();
    req.formData = formData;
    expectUnavailable(await POST(req));
    expect(formData).not.toHaveBeenCalled();
  });

  it("gives the generic unavailable redirect for a non-form (JSON) body", async () => {
    const req = new Request("https://www.compute-atlas.com/api/access/billing-portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: TOKEN }),
    });
    expectUnavailable(await POST(req));
    expect(getGrant).not.toHaveBeenCalled();
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("allows an explicit same-origin Sec-Fetch-Site and reaches the lookup", async () => {
    const res = await POST(formRequest(TOKEN, { "sec-fetch-site": "same-origin" }));
    expect(getGrant).toHaveBeenCalledWith(TOKEN);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PORTAL_URL);
  });

  it("gives the identical redirect for a missing token, bad token, free grant and no customer id", async () => {
    const locations = new Set<string>();
    const cases: Array<() => Promise<Response>> = [
      () => POST(formRequest(null)),
      async () => {
        getGrant.mockResolvedValue({ state: "inactive" });
        return POST(formRequest());
      },
      async () => {
        getGrant.mockResolvedValue(grant("free"));
        return POST(formRequest());
      },
      async () => {
        getGrant.mockResolvedValue(grant("commercial"));
        getCustomer.mockResolvedValue(null);
        return POST(formRequest());
      },
    ];
    for (const run of cases) {
      const res = await run();
      expectUnavailable(res);
      locations.add(res.headers.get("location") ?? "");
    }
    expect(locations.size).toBe(1);
    expect(createPortal).not.toHaveBeenCalled();
  });

  it("does not read the token from the query string", async () => {
    const req = new Request(`https://www.compute-atlas.com/api/access/billing-portal?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
    });
    expectUnavailable(await POST(req));
    expect(getGrant).not.toHaveBeenCalled();
  });

  it("303s to the portal for an active commercial grant, with the right customer and return URL", async () => {
    const res = await POST(formRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(PORTAL_URL);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(getGrant).toHaveBeenCalledWith(TOKEN);
    expect(getCustomer).toHaveBeenCalledWith("g1");
    const arg = createPortal.mock.calls[0][0] as { customerId: string; returnUrl: string };
    expect(arg.customerId).toBe("cus_123");
    expect(new URL(arg.returnUrl).pathname).toBe("/access/billing-return");
    expect(JSON.stringify(arg)).not.toContain(TOKEN);
  });

  it("redirects to unavailable and logs only the code when Stripe throws", async () => {
    createPortal.mockRejectedValue(Object.assign(new Error(`secret cus_123 ${TOKEN}`), { code: "rate_limit" }));
    expectUnavailable(await POST(formRequest()));
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("cus_123");
    expect(logged).not.toContain("secret");
  });

  it("logs 'config' for a StripeConfigError", async () => {
    createPortal.mockRejectedValue(new StripeConfigError("STRIPE_SECRET_KEY missing"));
    expectUnavailable(await POST(formRequest()));
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("config");
  });

  it("redirects to unavailable when the grant lookup throws, never logging the token", async () => {
    getGrant.mockRejectedValue(new Error(`Failed query: params: ${TOKEN}`));
    expectUnavailable(await POST(formRequest()));
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });
});
