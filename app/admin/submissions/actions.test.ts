import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest. Server Actions are
// independently callable endpoints (not gated solely by middleware page
// render), so both actions here MUST re-verify the admin session cookie
// before touching lib/submissions.ts — these tests assert that check
// happens and blocks the DB call when the cookie is invalid.
//
// A plain top-level `const mockX = vi.fn()` is NOT reliably safe to
// reference inside a vi.mock factory once the mocked module (actions.ts)
// imports more than one mocked specifier — the shared mocks here MUST go
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock calls themselves, not left to a fragile naming-based allowlist.
const {
  mockGetCookie,
  mockVerifySessionCookie,
  mockApproveSubmission,
  mockRejectSubmission,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockApproveSubmission: vi.fn(),
  mockRejectSubmission: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mockGetCookie,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/admin-session", () => ({
  SESSION_COOKIE_NAME: "admin_session",
  verifySessionCookie: mockVerifySessionCookie,
}));

vi.mock("@/lib/submissions", () => ({
  approveSubmission: mockApproveSubmission,
  rejectSubmission: mockRejectSubmission,
}));

import { approveSubmissionAction, rejectSubmissionAction } from "./actions";

describe("approveSubmissionAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockApproveSubmission.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls approveSubmission when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(approveSubmissionAction("sub-1")).rejects.toThrow();

    expect(mockApproveSubmission).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("calls approveSubmission and revalidates on a valid session + successful approve", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockApproveSubmission.mockResolvedValue({
      ok: true,
      submission: { id: "sub-1", status: "approved" },
      facility: { id: "fac-1" },
    });

    const result = await approveSubmissionAction("sub-1", "looks good");

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockApproveSubmission).toHaveBeenCalledWith("sub-1", "looks good");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/submissions");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when approveSubmission itself fails (e.g. already reviewed)", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockApproveSubmission.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Submission already approved",
    });

    const result = await approveSubmissionAction("sub-1");

    expect(result.ok).toBe(false);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("rejectSubmissionAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockRejectSubmission.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls rejectSubmission when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(rejectSubmissionAction("sub-1", "bad data")).rejects.toThrow();

    expect(mockRejectSubmission).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects and never calls rejectSubmission when the cookie is entirely missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(rejectSubmissionAction("sub-1", "bad data")).rejects.toThrow();

    expect(mockVerifySessionCookie).toHaveBeenCalledWith(undefined);
    expect(mockRejectSubmission).not.toHaveBeenCalled();
  });

  it("calls rejectSubmission and revalidates on a valid session + successful reject", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockRejectSubmission.mockResolvedValue({
      ok: true,
      submission: { id: "sub-1", status: "rejected" },
    });

    const result = await rejectSubmissionAction("sub-1", "duplicate entry");

    expect(mockRejectSubmission).toHaveBeenCalledWith("sub-1", "duplicate entry");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/submissions");
    expect(result.ok).toBe(true);
  });
});
