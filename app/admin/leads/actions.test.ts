import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest. Server Actions are
// independently callable endpoints (not gated solely by middleware page
// render), so every action here MUST re-verify the admin session cookie
// before touching lib/leads.ts — these tests assert that check happens and
// blocks the DB call when the cookie is invalid. Shared mocks go through
// vi.hoisted() so their initialization is hoisted alongside the vi.mock
// calls themselves, matching app/admin/submissions/actions.test.ts.
const {
  mockGetCookie,
  mockVerifySessionCookie,
  mockUpdateLeadStatus,
  mockResetLeadToNew,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockUpdateLeadStatus: vi.fn(),
  mockResetLeadToNew: vi.fn(),
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

vi.mock("@/lib/leads", () => ({
  updateLeadStatus: mockUpdateLeadStatus,
  resetLeadToNew: mockResetLeadToNew,
}));

import {
  markLeadResearchingAction,
  markLeadPromotedAction,
  dismissLeadAction,
  resetLeadToNewAction,
} from "./actions";

describe("markLeadResearchingAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockUpdateLeadStatus.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls updateLeadStatus when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(markLeadResearchingAction("lead-1")).rejects.toThrow();

    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects and never calls updateLeadStatus when the cookie is entirely missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(markLeadResearchingAction("lead-1")).rejects.toThrow();

    expect(mockVerifySessionCookie).toHaveBeenCalledWith(undefined);
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
  });

  it("calls updateLeadStatus(id, 'researching') and revalidates on a valid session + success", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateLeadStatus.mockResolvedValue({
      ok: true,
      lead: { id: "lead-1", status: "researching" },
    });

    const result = await markLeadResearchingAction("lead-1");

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockUpdateLeadStatus).toHaveBeenCalledWith("lead-1", "researching", undefined);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/leads");
    expect(result.ok).toBe(true);
  });

  it("does not revalidate when updateLeadStatus itself fails", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateLeadStatus.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Lead already researching",
    });

    const result = await markLeadResearchingAction("lead-1");

    expect(result.ok).toBe(false);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("markLeadPromotedAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockUpdateLeadStatus.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls updateLeadStatus when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(markLeadPromotedAction("lead-1")).rejects.toThrow();

    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
  });

  it("calls updateLeadStatus(id, 'promoted') and revalidates on success", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateLeadStatus.mockResolvedValue({
      ok: true,
      lead: { id: "lead-1", status: "promoted" },
    });

    const result = await markLeadPromotedAction("lead-1", "looks good");

    expect(mockUpdateLeadStatus).toHaveBeenCalledWith("lead-1", "promoted", "looks good");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/leads");
    expect(result.ok).toBe(true);
  });
});

describe("dismissLeadAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockUpdateLeadStatus.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never calls updateLeadStatus when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(dismissLeadAction("lead-1", "bad tip")).rejects.toThrow();

    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("requires a non-empty reason and never calls updateLeadStatus without one, even with a valid session", async () => {
    mockVerifySessionCookie.mockReturnValue(true);

    const result = await dismissLeadAction("lead-1", "   ");

    expect(result).toEqual({ ok: false, status: 400, error: "reason is required" });
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("calls updateLeadStatus(id, 'dismissed', reason) and revalidates on a valid session + reason", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockUpdateLeadStatus.mockResolvedValue({
      ok: true,
      lead: { id: "lead-1", status: "dismissed" },
    });

    const result = await dismissLeadAction("lead-1", "duplicate entry");

    expect(mockUpdateLeadStatus).toHaveBeenCalledWith("lead-1", "dismissed", "duplicate entry");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/leads");
    expect(result.ok).toBe(true);
  });
});

// The discovery lane queues listLeadsForAdmin("new") only, so `researching`,
// `promoted` and `dismissed` are all one-way doors out of that queue. This
// action is the only way back, and like every other action here it must
// re-verify the admin session before touching the DB.
describe("resetLeadToNewAction", () => {
  beforeEach(() => {
    mockGetCookie.mockClear();
    mockVerifySessionCookie.mockClear();
    mockUpdateLeadStatus.mockClear();
    mockResetLeadToNew.mockClear();
    mockRevalidatePath.mockClear();
    mockGetCookie.mockReturnValue({ value: "some-cookie-value" });
  });

  it("rejects and never touches the DB when the session cookie is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(resetLeadToNewAction("lead-1")).rejects.toThrow();

    expect(mockResetLeadToNew).not.toHaveBeenCalled();
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects and never touches the DB when the cookie is entirely missing", async () => {
    mockGetCookie.mockReturnValue(undefined);
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(resetLeadToNewAction("lead-1")).rejects.toThrow();

    expect(mockVerifySessionCookie).toHaveBeenCalledWith(undefined);
    expect(mockResetLeadToNew).not.toHaveBeenCalled();
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
  });

  // Must route through resetLeadToNew, NOT the generic updateLeadStatus: only
  // the former clears promotedSubmissionId and preserves the prior reviewNote.
  it("calls resetLeadToNew(id, note) and revalidates on a valid session + success", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockResetLeadToNew.mockResolvedValue({
      ok: true,
      lead: { id: "lead-1", status: "new" },
    });

    const result = await resetLeadToNewAction("lead-1", "re-opening, triaged in error");

    expect(mockVerifySessionCookie).toHaveBeenCalledWith("some-cookie-value");
    expect(mockResetLeadToNew).toHaveBeenCalledWith("lead-1", "re-opening, triaged in error");
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/leads");
    expect(result.ok).toBe(true);
  });

  it("passes an undefined note through when none is supplied", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockResetLeadToNew.mockResolvedValue({ ok: true, lead: { id: "lead-1", status: "new" } });

    await resetLeadToNewAction("lead-1");

    expect(mockResetLeadToNew).toHaveBeenCalledWith("lead-1", undefined);
    expect(mockUpdateLeadStatus).not.toHaveBeenCalled();
  });

  it("does not revalidate when resetLeadToNew itself fails", async () => {
    mockVerifySessionCookie.mockReturnValue(true);
    mockResetLeadToNew.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Lead already new",
    });

    const result = await resetLeadToNewAction("lead-1");

    expect(result.ok).toBe(false);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
