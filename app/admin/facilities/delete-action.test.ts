import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest. Server Actions are
// independently callable endpoints (not gated solely by middleware page
// render), so this action MUST re-verify the admin session cookie before
// touching lib/facility-write.ts — these tests assert that check happens and
// blocks the DB call when the cookie is invalid. Mirrors the pattern in
// app/admin/submissions/actions.test.ts.
//
// A plain top-level `const mockX = vi.fn()` is NOT reliably safe to
// reference inside a vi.mock factory once the mocked module (delete-action.ts)
// imports more than one mocked specifier — shared mocks go through
// vi.hoisted() so their initialization is hoisted alongside the vi.mock
// calls themselves.
const { mockGetCookie, mockVerifySessionCookie, mockDeleteFacility } = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockDeleteFacility: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mockGetCookie,
  })),
}));

vi.mock("@/lib/admin-session", () => ({
  SESSION_COOKIE_NAME: "admin_session",
  verifySessionCookie: mockVerifySessionCookie,
}));

vi.mock("@/lib/facility-write", () => ({
  deleteFacility: mockDeleteFacility,
}));

import { deleteFacilityAction } from "./delete-action";

describe("deleteFacilityAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockDeleteFacility.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls deleteFacility when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(deleteFacilityAction("fac-1")).rejects.toThrow();

    expect(mockDeleteFacility).not.toHaveBeenCalled();
  });

  it("rejects and never calls deleteFacility when the cookie is entirely missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(deleteFacilityAction("fac-1")).rejects.toThrow();

    expect(mockVerifySessionCookie).toHaveBeenCalledWith(undefined);
    expect(mockDeleteFacility).not.toHaveBeenCalled();
  });

  it("calls deleteFacility with the id on a valid session", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockDeleteFacility.mockResolvedValue({
      ok: true,
      facility: { id: "fac-1", name: "Test Facility" },
    });

    const result = await deleteFacilityAction("fac-1");

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockDeleteFacility).toHaveBeenCalledWith("fac-1");
    expect(result.ok).toBe(true);
  });

  it("propagates a 404 WriteResult when the facility doesn't exist", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockDeleteFacility.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Facility not found",
    });

    const result = await deleteFacilityAction("missing-fac");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });
});
