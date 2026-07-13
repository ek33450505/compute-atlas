import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest. Server Actions are
// independently callable endpoints (not gated solely by middleware page
// render), so createFacilityAction/updateFacilityAction MUST re-verify the
// admin session cookie before touching lib/facility-write.ts — these tests
// assert that check happens and blocks the DB call when the cookie is
// invalid. Mirrors app/admin/facilities/delete-action.test.ts.
//
// A plain top-level `const mockX = vi.fn()` is NOT reliably safe to
// reference inside a vi.mock factory once the mocked module imports more
// than one mocked specifier — shared mocks go through vi.hoisted() so their
// initialization is hoisted alongside the vi.mock calls themselves.
const { mockGetCookie, mockVerifySessionCookie, mockCreateFacility, mockUpdateFacility } =
  vi.hoisted(() => ({
    mockGetCookie: vi.fn(),
    mockVerifySessionCookie: vi.fn(),
    mockCreateFacility: vi.fn(),
    mockUpdateFacility: vi.fn(),
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
  createFacility: mockCreateFacility,
  updateFacility: mockUpdateFacility,
}));

import { createFacilityAction, updateFacilityAction } from "./facility-form-actions";

describe("createFacilityAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockCreateFacility.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls createFacility when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(createFacilityAction({ id: "fac-1" })).rejects.toThrow();

    expect(mockCreateFacility).not.toHaveBeenCalled();
  });

  it("rejects and never calls createFacility when the cookie is entirely missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(createFacilityAction({ id: "fac-1" })).rejects.toThrow();

    expect(mockVerifySessionCookie).toHaveBeenCalledWith(undefined);
    expect(mockCreateFacility).not.toHaveBeenCalled();
  });

  it("calls createFacility with the input on a valid session", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockCreateFacility.mockResolvedValue({
      ok: true,
      facility: { id: "fac-1", name: "Test Facility" },
    });

    const input = { id: "fac-1", name: "Test Facility" };
    const result = await createFacilityAction(input);

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockCreateFacility).toHaveBeenCalledWith(input);
    expect(result.ok).toBe(true);
  });

  it("propagates a 400 WriteResult with issues when validation fails", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockCreateFacility.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Invalid facility",
      issues: [{ path: ["name"], message: "Required" }],
    });

    const result = await createFacilityAction({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.issues).toEqual([{ path: ["name"], message: "Required" }]);
    }
  });
});

describe("updateFacilityAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockUpdateFacility.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls updateFacility when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(updateFacilityAction("fac-1", { name: "x" })).rejects.toThrow();

    expect(mockUpdateFacility).not.toHaveBeenCalled();
  });

  it("calls updateFacility with the id and patch on a valid session", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateFacility.mockResolvedValue({
      ok: true,
      facility: { id: "fac-1", name: "Updated Name" },
    });

    const patch = { name: "Updated Name" };
    const result = await updateFacilityAction("fac-1", patch);

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockUpdateFacility).toHaveBeenCalledWith("fac-1", patch);
    expect(result.ok).toBe(true);
  });

  it("propagates a 404 WriteResult when the facility doesn't exist", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateFacility.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Facility not found",
    });

    const result = await updateFacilityAction("missing-fac", { name: "x" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });
});
