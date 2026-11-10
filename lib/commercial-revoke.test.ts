import { describe, it, expect, vi, beforeEach } from "vitest";

import { cancelSubscriptionForRevokedGrant, type RevokeCancelDeps } from "@/lib/commercial-revoke";

type Row = { status: string; tier: string; stripeSubscriptionId: string | null };

function makeDeps(row: Row | undefined, cancel = vi.fn().mockResolvedValue({}), retrieve = vi.fn()) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  const deps = { db, stripe: { subscriptions: { cancel, retrieve } } } as unknown as RevokeCancelDeps;
  return { deps, cancel, retrieve };
}

const revokedCommercial: Row = { status: "revoked", tier: "commercial", stripeSubscriptionId: "sub_123" };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cancelSubscriptionForRevokedGrant", () => {
  it("cancels with an idempotency key derived from the grant and never refunds", async () => {
    const { deps, cancel } = makeDeps(revokedCommercial);
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledWith("sub_123", {}, { idempotencyKey: "ca-admin-revoke-g1" });
  });

  it.each([
    ["a free grant", { ...revokedCommercial, tier: "free" }],
    ["a grant that is not revoked", { ...revokedCommercial, status: "active" }],
    ["a missing grant", undefined],
  ])("does nothing for %s", async (_name, row) => {
    const { deps, cancel } = makeDeps(row);
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "not_commercial" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports no_subscription when no subscription is linked", async () => {
    const { deps, cancel } = makeDeps({ ...revokedCommercial, stripeSubscriptionId: null });
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "no_subscription" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("counts an already-canceled subscription as done", async () => {
    const { deps } = makeDeps(
      revokedCommercial,
      vi.fn().mockRejectedValue(new Error("gone")),
      vi.fn().mockResolvedValue({ status: "canceled" })
    );
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: true });
  });

  it("reports stripe_error when the cancel fails and the subscription is still live", async () => {
    const { deps } = makeDeps(
      revokedCommercial,
      vi.fn().mockRejectedValue(new Error("boom sub_123")),
      vi.fn().mockResolvedValue({ status: "active" })
    );
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "stripe_error" });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).not.toContain("sub_123");
  });

  it("reports lookup_failed (not stripe_error) when the grant read throws, and never calls Stripe", async () => {
    const { deps, cancel } = makeDeps(revokedCommercial);
    (deps as unknown as { db: unknown }).db = {
      select: () => ({ from: () => ({ where: () => ({ limit: vi.fn().mockRejectedValue(new Error("db down")) }) }) }),
    };
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "lookup_failed" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports stripe_error when the read-back also fails", async () => {
    const { deps } = makeDeps(
      revokedCommercial,
      vi.fn().mockRejectedValue(new Error("boom")),
      vi.fn().mockRejectedValue(new Error("down"))
    );
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "stripe_error" });
  });
});
