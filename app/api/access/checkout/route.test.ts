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

import { GET, POST } from "./route";

function formRequest(plan?: string): Request {
  const body = new URLSearchParams(plan === undefined ? {} : { plan });
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

  it("treats a non-form body as a bad plan", async () => {
    const req = new Request("https://www.compute-atlas.com/api/access/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "monthly" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(303);
    expect(location(res).search).toBe("?error=plan");
  });

  it("refuses a cross-site POST before recording a rate-limit attempt", async () => {
    const req = formRequest("monthly");
    const cross = new Request(req, { headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } });
    const res = await POST(cross);
    expect(res.status).toBe(303);
    noStore(res);
    expect(location(res).search).toBe("?error=plan");
    expect(checkLimit).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it.each(["same-origin", "same-site", "none"])("allows sec-fetch-site: %s", async (site) => {
    const body = new URLSearchParams({ plan: "monthly" });
    const res = await POST(
      new Request("https://www.compute-atlas.com/api/access/checkout", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": site },
        body,
      })
    );
    expect(res.status).toBe(403);
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

  it("answers 403 no-store for a valid plan until the PayPal checkout lands", async () => {
    const res = await POST(formRequest("annual"));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(recordAttempt).toHaveBeenCalledWith("commercial-checkout", expect.any(String));
  });
});
