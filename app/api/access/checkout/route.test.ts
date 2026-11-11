// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkLimit = vi.fn();
const recordAttempt = vi.fn();

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkIntakeRateLimit: (...a: unknown[]) => checkLimit(...a),
    recordIntakeAttempt: (...a: unknown[]) => recordAttempt(...a),
  };
});

const startCheckout = vi.fn();
vi.mock("@/lib/commercial-checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commercial-checkout")>();
  return { ...actual, startCommercialCheckout: (...a: unknown[]) => startCheckout(...a) };
});
vi.mock("@/lib/db/client", () => ({ getDb: () => ({ fake: "db" }) }));

import { GET, POST } from "./route";

const VALID = {
  email: "Buyer@Example.com",
  name: "Pat Buyer",
  organization: "Example Capital",
  acceptTerms: "on",
};

function formRequest(plan?: string, extra: Record<string, string | undefined> = {}): Request {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...VALID, ...(plan === undefined ? {} : { plan }), ...extra })) {
    if (v !== undefined) fields[k] = v;
  }
  const body = new URLSearchParams(fields);
  return new Request("https://www.compute-atlas.com/api/access/checkout", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function noStore(res: Response) {
  expect(res.headers.get("cache-control")).toContain("no-store");
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "", "https://x.invalid");
}

beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.test");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  checkLimit.mockResolvedValue({ ok: true });
  recordAttempt.mockResolvedValue(undefined);
  startCheckout.mockResolvedValue({ ok: true, approveUrl: "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/access/checkout", () => {
  it("is 403 with the flag off and does no work", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    const res = await POST(formRequest("monthly"));
    expect(res.status).toBe(403);
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it("is 403 when dataset sharing is off and does no work", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    const res = await POST(formRequest("monthly"));
    expect(res.status).toBe(403);
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it.each([["CONTACT_TO_EMAIL"], ["RESEND_API_KEY"]])(
    "refuses to start a checkout when %s is missing, before any rate-limit work",
    async (name) => {
      vi.stubEnv(name, "  ");
      const res = await POST(formRequest("monthly"));
      expect(res.status).toBe(303);
      noStore(res);
      expect(location(res).search).toBe("?error=unavailable");
      expect(res.headers.get("location")).not.toContain(name);
      expect(checkLimit).not.toHaveBeenCalled();
      expect(recordAttempt).not.toHaveBeenCalled();
      }
  );

  it("answers GET with a no-store 405", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it.each(["weekly", "", "MONTHLY"])("redirects a bad plan (%j) back with ?error=plan", async (plan) => {
    const res = await POST(formRequest(plan));
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).pathname + location(res).search).toBe("/access/commercial?error=plan");
  });

  it("redirects a missing plan back with ?error=plan", async () => {
    const res = await POST(formRequest());
    expect(location(res).search).toBe("?error=plan");
    noStore(res);
  });

  it("treats a non-form body as invalid details", async () => {
    const req = new Request("https://www.compute-atlas.com/api/access/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "monthly" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(303);
    expect(location(res).search).toBe("?error=details");
  });

  it.each(["cross-site", "same-site"])("refuses sec-fetch-site: %s with ?error=request before any rate-limit work", async (site) => {
    const res = await POST(
      new Request("https://www.compute-atlas.com/api/access/checkout", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site },
        body: new URLSearchParams({ ...VALID, plan: "monthly" }),
      })
    );
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).search).toBe("?error=request");
    expect(checkLimit).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });

  const withOrigin = (origin: string) =>
    new Request("https://www.compute-atlas.com/api/access/checkout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ ...VALID, plan: "monthly" }),
    });

  it.each(["https://evil.example", "null", "http://www.compute-atlas.com"])("refuses Origin %s", async (origin) => {
    const res = await POST(withOrigin(origin));
    expect(location(res).search).toBe("?error=request");
    expect(checkLimit).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it.each(["https://www.compute-atlas.com"])("accepts Origin %s", async (origin) => {
    const res = await POST(withOrigin(origin));
    expect(res.headers.get("location")).toContain("paypal.com");
  });

  it.each(["same-origin", "none"])("allows sec-fetch-site: %s", async (site) => {
    const body = new URLSearchParams({ ...VALID, plan: "monthly" });
    const res = await POST(
      new Request("https://www.compute-atlas.com/api/access/checkout", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site },
        body,
      })
    );
    expect(res.headers.get("location")).toContain("paypal.com");
  });

  it("redirects with ?error=busy when rate limited, recording nothing", async () => {
    checkLimit.mockResolvedValue({ ok: false });
    const res = await POST(formRequest("monthly"));
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).search).toBe("?error=busy");
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it("redirects with ?error=unavailable when the rate-limit store fails", async () => {
    checkLimit.mockRejectedValue(new Error("db down"));
    const res = await POST(formRequest("monthly"));
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).search).toBe("?error=unavailable");
  });

  it("303s to the PayPal approveUrl with no-store on success, passing normalised input", async () => {
    const res = await POST(formRequest("annual"));
    expect(res.status).toBe(303);
    noStore(res);
    expect(res.headers.get("location")).toBe("https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1");
    expect(recordAttempt).toHaveBeenCalledWith("commercial-checkout", expect.any(String));
    expect(startCheckout).toHaveBeenCalledWith(
      { fake: "db" },
      { plan: "annual", email: "buyer@example.com", name: "Pat Buyer", organization: "Example Capital", acceptTerms: "on" }
    );
  });

  it("refuses unticked terms with ?error=terms and no checkout", async () => {
    const res = await POST(formRequest("monthly", { acceptTerms: undefined }));
    expect(location(res).search).toBe("?error=terms");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ["bad email", { email: "nope" }],
    ["missing email", { email: undefined }],
    ["blank name", { name: "   " }],
    ["markup in name", { name: "<b>x</b>" }],
    ["missing organization", { organization: undefined }],
    ["overlong organization", { organization: "x".repeat(201) }],
  ])("refuses invalid details (%s) with ?error=details and no checkout", async (_label, extra) => {
    const res = await POST(formRequest("monthly", extra));
    expect(res.status).toBe(303);
    expect(location(res).search).toBe("?error=details");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("refuses a bad plan before starting any checkout", async () => {
    await POST(formRequest("weekly"));
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("maps a volume-cap refusal to ?error=busy", async () => {
    startCheckout.mockResolvedValue({ ok: false, reason: "busy" });
    const res = await POST(formRequest("monthly"));
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).search).toBe("?error=busy");
  });

  it("maps an unavailable checkout to ?error=unavailable", async () => {
    startCheckout.mockResolvedValue({ ok: false, reason: "unavailable" });
    const res = await POST(formRequest("monthly"));
    expect(location(res).search).toBe("?error=unavailable");
  });

  it("never echoes a submitted value into a redirect", async () => {
    const secret = { email: "secret@example.com", name: "Zed Secret", organization: "SecretOrg" };
    for (const outcome of [
      { ok: false, reason: "busy" },
      { ok: false, reason: "unavailable" },
    ]) {
      startCheckout.mockResolvedValue(outcome);
      const res = await POST(formRequest("monthly", secret));
      const loc = decodeURIComponent(res.headers.get("location") ?? "");
      expect(loc).not.toMatch(/secret/i);
    }
    const bad = await POST(formRequest("monthly", { ...secret, email: "secret-not-an-email" }));
    expect(decodeURIComponent(bad.headers.get("location") ?? "")).not.toMatch(/secret/i);
  });
});
