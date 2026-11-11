import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCancel } = vi.hoisted(() => ({ mockCancel: vi.fn() }));
vi.mock("@/lib/paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/paypal")>()),
  cancelSubscription: mockCancel,
}));

import { PayPalConfigError } from "@/lib/paypal";
import { cancelSubscriptionForRevokedGrant, type RevokeCancelDeps } from "@/lib/commercial-revoke";

type Row = { status: string; tier: string; paypalSubscriptionId: string | null };

function makeDeps(row: Row | undefined) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  const deps = { db } as unknown as RevokeCancelDeps;
  return { deps, cancel: mockCancel };
}

const revokedCommercial: Row = { status: "revoked", tier: "commercial", paypalSubscriptionId: "I-SUB123" };

beforeEach(() => {
  mockCancel.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cancelSubscriptionForRevokedGrant", () => {
  it("cancels the PayPal subscription with a reason", async () => {
    const { deps, cancel } = makeDeps(revokedCommercial);
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledWith("I-SUB123", "Access revoked by Compute Atlas");
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
    const { deps, cancel } = makeDeps({ ...revokedCommercial, paypalSubscriptionId: null });
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "no_subscription" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("counts an already-inactive subscription as done", async () => {
    const { deps } = makeDeps(revokedCommercial);
    mockCancel.mockResolvedValue({ ok: true, alreadyInactive: true });
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: true });
  });

  it("reports provider_error when the cancel fails", async () => {
    const { deps } = makeDeps(revokedCommercial);
    mockCancel.mockRejectedValue(new Error("boom I-SUB123"));
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "provider_error" });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).not.toContain("I-SUB123");
  });

  it("logs code config (not unknown) for a PayPalConfigError, still provider_error", async () => {
    const { deps } = makeDeps(revokedCommercial);
    mockCancel.mockRejectedValue(new PayPalConfigError("PAYPAL_CLIENT_SECRET"));
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "provider_error" });
    const logged = String(vi.mocked(console.error).mock.calls[0]?.[0]);
    expect(logged).toContain("code: config");
    expect(logged).not.toContain("PAYPAL_CLIENT_SECRET");
  });

  it("reports lookup_failed (not provider_error) when the grant read throws, and never calls PayPal", async () => {
    const { deps, cancel } = makeDeps(revokedCommercial);
    (deps as unknown as { db: unknown }).db = {
      select: () => ({ from: () => ({ where: () => ({ limit: vi.fn().mockRejectedValue(new Error("db down")) }) }) }),
    };
    expect(await cancelSubscriptionForRevokedGrant("g1", deps)).toEqual({ cancelled: false, reason: "lookup_failed" });
    expect(cancel).not.toHaveBeenCalled();
  });
});
