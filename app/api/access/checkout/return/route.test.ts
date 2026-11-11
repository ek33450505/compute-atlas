// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activate = vi.fn();
vi.mock("@/lib/commercial-activation", () => ({
  activateFromPayPal: (...a: unknown[]) => activate(...a),
}));

const limit = vi.fn();
const getDb = vi.fn();
vi.mock("@/lib/db/client", () => ({ getDb: () => getDb() }));

const afterMock = vi.fn();
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (...a: unknown[]) => afterMock(...a) };
});

import { PayPalApiError } from "@/lib/paypal";
import { GET } from "./route";

const ID = "3f2b8a52-6c1e-4f0d-9a77-0c1d2e3f4a5b";
const SUCCESS = "https://www.compute-atlas.com/access/commercial/success";

function dbReturning(rows: unknown[]) {
  limit.mockResolvedValue(rows);
  getDb.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit }) }) }) });
}

function req(query: string): Request {
  return new Request(`https://www.compute-atlas.com/api/access/checkout/return${query}`);
}

function expectHeaders(res: Response) {
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  activate.mockReset();
  afterMock.mockReset();
  limit.mockReset();
  getDb.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/access/checkout/return", () => {
  it("redirects to the commercial page when checkout is closed, with no work", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "false");
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe("https://www.compute-atlas.com/access/commercial");
    expect(getDb).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(["", "?checkout=", "?checkout=nope", `?checkout=${ID}x`, `?checkout=${ID}' OR 1=1`])(
    "sends %j to success with no DB or activation work",
    async (q) => {
      const res = await GET(req(q));
      expectHeaders(res);
      expect(res.headers.get("location")).toBe(SUCCESS);
      expect(getDb).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
    }
  );

  it("does not activate for an unknown row", async () => {
    dbReturning([]);
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe(SUCCESS);
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not activate for a row without a subscription id", async () => {
    dbReturning([{ paypalSubscriptionId: null }]);
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe(SUCCESS);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "activated", grantId: "g" },
    { kind: "refused", reason: "duplicate_subscription" },
    { kind: "pending", status: "APPROVAL_PENDING" },
    { kind: "ignored", reason: "x" },
  ])("lands on the same page for outcome $kind", async (outcome) => {
    dbReturning([{ paypalSubscriptionId: "I-DB" }]);
    activate.mockResolvedValue(outcome);
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe(SUCCESS);
    expect(activate).toHaveBeenCalledWith("I-DB");
  });

  it("lands on the same page when activation throws, logging codes only", async () => {
    dbReturning([{ paypalSubscriptionId: "I-DB" }]);
    activate.mockRejectedValue(new Error("boom buyer@example.com"));
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe(SUCCESS);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain("buyer@example.com");
  });

  it("times out a hung activation after 8s and still redirects", async () => {
    vi.useFakeTimers();
    try {
      dbReturning([{ paypalSubscriptionId: "I-DB" }]);
      activate.mockReturnValue(new Promise(() => {}));
      const pending = GET(req(`?checkout=${ID}`));
      await vi.advanceTimersByTimeAsync(8000);
      const res = await pending;
      expectHeaders(res);
      expect(res.headers.get("location")).toBe(SUCCESS);
      expect(JSON.stringify(errSpy.mock.calls)).toContain("checkout-return activation timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out activation alive via after() and logs a late rejection", async () => {
    vi.useFakeTimers();
    try {
      dbReturning([{ paypalSubscriptionId: "I-DB" }]);
      let reject!: (e: unknown) => void;
      activate.mockReturnValue(new Promise((_, r) => (reject = r)));
      const pending = GET(req(`?checkout=${ID}`));
      await vi.advanceTimersByTimeAsync(8000);
      await pending;
      expect(afterMock).toHaveBeenCalledTimes(1);
      const kept = afterMock.mock.calls[0][0] as () => Promise<void>;
      reject(new PayPalApiError(502, "BAD_GATEWAY", "dbg9"));
      await kept();
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).toContain("late activation failed");
      expect(logged).toContain("502");
      expect(logged).toContain("dbg9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call after() when activation finishes in time", async () => {
    dbReturning([{ paypalSubscriptionId: "I-DB" }]);
    activate.mockResolvedValue({ kind: "activated", grantId: "g" });
    await GET(req(`?checkout=${ID}`));
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("clears the timer when activation finishes in time", async () => {
    vi.useFakeTimers();
    try {
      dbReturning([{ paypalSubscriptionId: "I-DB" }]);
      activate.mockResolvedValue({ kind: "activated", grantId: "g" });
      await GET(req(`?checkout=${ID}`));
      expect(vi.getTimerCount()).toBe(0);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lands on the same page when the DB lookup throws", async () => {
    getDb.mockReturnValue({ select: () => { throw new Error("db down"); } });
    const res = await GET(req(`?checkout=${ID}`));
    expectHeaders(res);
    expect(res.headers.get("location")).toBe(SUCCESS);
    expect(activate).not.toHaveBeenCalled();
  });

  it("never passes PayPal-appended params to activation", async () => {
    dbReturning([{ paypalSubscriptionId: "I-DB" }]);
    activate.mockResolvedValue({ kind: "activated", grantId: "g" });
    await GET(req(`?checkout=${ID}&subscription_id=I-ATTACKER&ba_token=BA-1&token=EC-1`));
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith("I-DB");
  });
});
