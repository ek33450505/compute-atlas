import { vi, describe, it, expect, beforeEach } from "vitest";

// Server Actions are independently callable, so each action must re-verify the admin session before
// touching a grant or sending mail. Mocking style mirrors app/admin/contact/actions.test.ts.
const {
  mockGetCookie,
  mockVerifySessionCookie,
  mockRevalidatePath,
  mockApprove,
  mockReject,
  mockRedirect,
  mockRevoke,
  mockReissue,
  mockExtend,
  mockDeliver,
  mockHasRecentReissue,
  mockBuildEdition,
} = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockRedirect: vi.fn(),
  mockRevoke: vi.fn(),
  mockReissue: vi.fn(),
  mockExtend: vi.fn(),
  mockDeliver: vi.fn(),
  mockHasRecentReissue: vi.fn(),
  mockBuildEdition: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockGetCookie })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/admin-session", () => ({
  SESSION_COOKIE_NAME: "admin_session",
  verifySessionCookie: mockVerifySessionCookie,
}));
vi.mock("@/lib/dataset-grants", () => ({
  approveDatasetGrant: mockApprove,
  rejectDatasetGrant: mockReject,
  redirectDatasetGrantToPaid: mockRedirect,
  revokeDatasetGrant: mockRevoke,
  reissueDatasetLink: mockReissue,
  extendDatasetGrant: mockExtend,
}));
vi.mock("@/lib/dataset-admin", () => ({ hasRecentLinkReissue: mockHasRecentReissue }));
vi.mock("@/lib/dataset-mail", () => ({ deliverDatasetReviewMail: mockDeliver }));
vi.mock("@/lib/dataset-edition-builder", () => ({ buildEdition: mockBuildEdition }));

import {
  approveDatasetGrantAction,
  buildEditionNowAction,
  extendDatasetGrantAction,
  reissueDatasetLinkAction,
  redirectDatasetGrantToPaidAction,
  rejectDatasetGrantAction,
  revokeDatasetGrantAction,
} from "./actions";

const ID = "5b0f3c0e-7a0d-4c8e-9d54-0f2a6a1d2b3c";
const EMAIL = "requester@example.org";
const TOKEN = "SECRET_ACCESS_TOKEN_abcdefghijklmnopqrstuvwxyz0123";
const NOT_ELIGIBLE = {
  ok: false,
  error:
    "This grant is no longer in a state this action applies to. The list has been refreshed; check it before retrying.",
};
const UPDATE_FAILED = { ok: false, error: "Could not update the grant. Try again." };

const EDITION_ID = "9d1c2e4f-0b3a-4f6d-8a7e-1c2b3d4e5f60";

const approvedIntent = { kind: "dataset_approved", grantId: ID, email: EMAIL, accessToken: TOKEN };
const rejectedIntent = { kind: "dataset_rejected", grantId: ID, email: EMAIL, rejectionNote: "Out of scope." };
const redirectIntent = { kind: "dataset_commercial_redirect", grantId: ID, email: EMAIL };
const reissuedIntent = { kind: "dataset_link_reissued", grantId: ID, email: EMAIL, accessToken: TOKEN };

/** Everything the console received, flattened, so a leak anywhere in the arguments is found. */
function consoleOutput(spies: { mock: { calls: unknown[][] } }[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "))
    .join("\n");
}

let consoleSpies: { mock: { calls: unknown[][] } }[];

beforeEach(() => {
  vi.resetAllMocks();
  mockGetCookie.mockReturnValue({ value: "cookie" });
  mockVerifySessionCookie.mockReturnValue(true);
  mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: approvedIntent });
  mockReject.mockResolvedValue({ ok: true, mail: rejectedIntent });
  mockRedirect.mockResolvedValue({ ok: true, mail: redirectIntent });
  mockRevoke.mockResolvedValue({ ok: true });
  mockReissue.mockResolvedValue({ ok: true, mail: reissuedIntent });
  mockExtend.mockResolvedValue({ ok: true });
  mockDeliver.mockResolvedValue({ sent: true, disposition: "sent" });
  mockHasRecentReissue.mockResolvedValue(false);
  mockBuildEdition.mockResolvedValue({
    outcome: "published",
    editionId: EDITION_ID,
    editionDate: "2026-11-09",
    recordCount: 3012,
  });
  consoleSpies = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
});

describe("session gate", () => {
  it.each([
    ["approveDatasetGrantAction", () => approveDatasetGrantAction(ID)],
    ["rejectDatasetGrantAction", () => rejectDatasetGrantAction(ID)],
    ["redirectDatasetGrantToPaidAction", () => redirectDatasetGrantToPaidAction(ID)],
    ["revokeDatasetGrantAction", () => revokeDatasetGrantAction(ID)],
    ["reissueDatasetLinkAction", () => reissueDatasetLinkAction(ID)],
    ["extendDatasetGrantAction", () => extendDatasetGrantAction(ID)],
  ])("%s rejects Unauthorized and touches nothing without a valid session", async (_name, run) => {
    mockVerifySessionCookie.mockReturnValue(false);
    await expect(run()).rejects.toThrow("Unauthorized");
    for (const fn of [mockApprove, mockReject, mockRedirect, mockRevoke, mockReissue, mockExtend, mockDeliver, mockRevalidatePath, mockHasRecentReissue]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("approveDatasetGrantAction", () => {
  it("delivers the intent unchanged and returns only the disposition", async () => {
    const result = await approveDatasetGrantAction(ID, "Looks fine.");

    expect(mockApprove).toHaveBeenCalledWith(ID, { reviewNote: "Looks fine." });
    expect(mockDeliver).toHaveBeenCalledWith(approvedIntent);
    expect(result).toEqual({ ok: true, kind: "approved", mail: "sent" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("surfaces a non-sent disposition so the admin knows the requester has no link", async () => {
    mockDeliver.mockResolvedValue({ sent: false, disposition: "skipped_suppressed" });
    expect(await approveDatasetGrantAction(ID)).toEqual({ ok: true, kind: "approved", mail: "skipped_suppressed" });
  });

  it("never logs the token or the address", async () => {
    await approveDatasetGrantAction(ID);
    const out = consoleOutput(consoleSpies);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(EMAIL);
  });

  it("sends no mail when approving a renewal", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "renewed" });
    expect(await approveDatasetGrantAction(ID)).toEqual({ ok: true, kind: "renewed" });
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("drops a non-string review note", async () => {
    await approveDatasetGrantAction(ID, {} as never);
    expect(mockApprove).toHaveBeenCalledWith(ID, { reviewNote: undefined });
  });
});

describe("rejectDatasetGrantAction", () => {
  it("forwards both notes, delivers the intent and returns the disposition", async () => {
    const result = await rejectDatasetGrantAction(ID, { reviewNote: "internal", rejectionNote: "Out of scope." });

    expect(mockReject).toHaveBeenCalledWith(ID, { reviewNote: "internal", rejectionNote: "Out of scope." });
    expect(mockDeliver).toHaveBeenCalledWith(rejectedIntent);
    expect(result).toEqual({ ok: true, mail: "sent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("reports a non-sent disposition", async () => {
    mockDeliver.mockResolvedValue({ sent: false, disposition: "send_failed" });
    expect(await rejectDatasetGrantAction(ID)).toEqual({ ok: true, mail: "send_failed" });
  });

  it.each([[undefined], [null], ["a string"], [123], [[]]])("tolerates notes = %j", async (notes) => {
    await expect(rejectDatasetGrantAction(ID, notes as never)).resolves.toEqual({ ok: true, mail: "sent" });
    expect(mockReject).toHaveBeenCalledWith(ID, { reviewNote: undefined, rejectionNote: undefined });
  });

  it("drops non-string note fields", async () => {
    await rejectDatasetGrantAction(ID, { reviewNote: 5, rejectionNote: {} } as never);
    expect(mockReject).toHaveBeenCalledWith(ID, { reviewNote: undefined, rejectionNote: undefined });
  });
});

describe("redirectDatasetGrantToPaidAction", () => {
  it("delivers the redirect intent and returns only the disposition", async () => {
    const result = await redirectDatasetGrantToPaidAction(ID);

    expect(mockRedirect).toHaveBeenCalledWith(ID);
    expect(mockDeliver).toHaveBeenCalledWith(redirectIntent);
    expect(result).toEqual({ ok: true, mail: "sent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("returns not-eligible and sends nothing when the lib refuses", async () => {
    mockRedirect.mockResolvedValue({ ok: false });
    expect(await redirectDatasetGrantToPaidAction(ID)).toEqual(NOT_ELIGIBLE);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("reports an update failure without leaking, and sends nothing", async () => {
    mockRedirect.mockRejectedValue(new Error("boom"));
    expect(await redirectDatasetGrantToPaidAction(ID)).toEqual(UPDATE_FAILED);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("is not eligible for a non-string id", async () => {
    expect(await redirectDatasetGrantToPaidAction(5 as never)).toEqual(NOT_ELIGIBLE);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe("revokeDatasetGrantAction", () => {
  it("forwards the reason and sends no mail", async () => {
    expect(await revokeDatasetGrantAction(ID, "Misused.")).toEqual({ ok: true });
    expect(mockRevoke).toHaveBeenCalledWith(ID, { reason: "Misused." });
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("drops a non-string reason", async () => {
    await revokeDatasetGrantAction(ID, 42 as never);
    expect(mockRevoke).toHaveBeenCalledWith(ID, { reason: undefined });
  });
});

describe("reissueDatasetLinkAction", () => {
  it("delivers the intent unchanged and returns only the disposition", async () => {
    const result = await reissueDatasetLinkAction(ID);

    expect(mockReissue).toHaveBeenCalledWith(ID);
    expect(mockDeliver).toHaveBeenCalledWith(reissuedIntent);
    expect(result).toEqual({ ok: true, mail: "sent" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    const out = consoleOutput(consoleSpies);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(EMAIL);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("surfaces a non-sent disposition", async () => {
    mockDeliver.mockResolvedValue({ sent: false, disposition: "skipped_capped" });
    expect(await reissueDatasetLinkAction(ID)).toEqual({ ok: true, mail: "skipped_capped" });
  });

  it("refuses inside the cooldown BEFORE rotating the token or mailing", async () => {
    mockHasRecentReissue.mockResolvedValue(true);

    const result = await reissueDatasetLinkAction(ID);

    expect(result).toEqual({
      ok: false,
      error: "A new link was emailed to this requester less than 10 minutes ago. Wait before sending another.",
    });
    expect(mockHasRecentReissue).toHaveBeenCalledWith(ID);
    expect(mockReissue).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("proceeds when no reissue mail was sent recently", async () => {
    mockHasRecentReissue.mockResolvedValue(false);
    expect(await reissueDatasetLinkAction(ID)).toEqual({ ok: true, mail: "sent" });
    expect(mockReissue).toHaveBeenCalledWith(ID);
  });

  it("returns the generic error and logs a SQLSTATE only when the cooldown check throws", async () => {
    mockHasRecentReissue.mockRejectedValue(
      Object.assign(new Error(`Failed query: select ... params: ${ID}, ${EMAIL}`), { code: "57P01" })
    );

    expect(await reissueDatasetLinkAction(ID)).toEqual(UPDATE_FAILED);

    expect(mockReissue).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
    const out = consoleOutput(consoleSpies);
    expect(out).toContain("sqlstate: 57P01");
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain(EMAIL);
  });
});

describe("extendDatasetGrantAction", () => {
  it("extends and sends no mail", async () => {
    expect(await extendDatasetGrantAction(ID)).toEqual({ ok: true });
    expect(mockExtend).toHaveBeenCalledWith(ID);
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });
});

describe("not eligible", () => {
  const gone = { ok: false, reason: "not_eligible" };

  it.each([
    ["approve", mockApprove, () => approveDatasetGrantAction(ID)],
    ["reject", mockReject, () => rejectDatasetGrantAction(ID)],
    ["revoke", mockRevoke, () => revokeDatasetGrantAction(ID)],
    ["reissue", mockReissue, () => reissueDatasetLinkAction(ID)],
    ["extend", mockExtend, () => extendDatasetGrantAction(ID)],
  ])("%s returns the refresh error without mailing or revalidating", async (_name, lib, run) => {
    lib.mockResolvedValue(gone);
    expect(await run()).toEqual(NOT_ELIGIBLE);
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("a lib failure", () => {
  const boom = () =>
    Object.assign(new Error(`Failed query: update "dataset_grants" ... params: ${EMAIL}, ${TOKEN}`), {
      code: "57P01",
    });

  it.each([
    ["approve", mockApprove, () => approveDatasetGrantAction(ID)],
    ["reject", mockReject, () => rejectDatasetGrantAction(ID)],
    ["revoke", mockRevoke, () => revokeDatasetGrantAction(ID)],
    ["reissue", mockReissue, () => reissueDatasetLinkAction(ID)],
    ["extend", mockExtend, () => extendDatasetGrantAction(ID)],
  ])("%s returns the generic error, logs a SQLSTATE only, and does not mail", async (_name, lib, run) => {
    lib.mockRejectedValue(boom());
    expect(await run()).toEqual(UPDATE_FAILED);

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
    const out = consoleOutput(consoleSpies);
    expect(out).toContain("sqlstate: 57P01");
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("Failed query");
  });
});

describe("untrusted input", () => {
  it.each([[123], [{}], [null], [undefined], [["x"]]])(
    "a non-string id (%j) never reaches the lib and does not throw",
    async (badId) => {
      for (const run of [
        () => approveDatasetGrantAction(badId as never),
        () => rejectDatasetGrantAction(badId as never),
        () => revokeDatasetGrantAction(badId as never),
        () => reissueDatasetLinkAction(badId as never),
        () => extendDatasetGrantAction(badId as never),
      ]) {
        expect(await run()).toEqual(NOT_ELIGIBLE);
      }
      for (const fn of [mockApprove, mockReject, mockRevoke, mockReissue, mockExtend, mockDeliver, mockRevalidatePath, mockHasRecentReissue]) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  );
});

describe("buildEditionNowAction", () => {
  it("rejects Unauthorized and builds nothing without a valid session", async () => {
    mockVerifySessionCookie.mockReturnValue(false);

    await expect(buildEditionNowAction()).rejects.toThrow("Unauthorized");

    expect(mockBuildEdition).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it("builds once and reports a published edition without its id", async () => {
    const result = await buildEditionNowAction();

    expect(mockBuildEdition).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, outcome: "published", editionDate: "2026-11-09", recordCount: 3012 });
    expect(JSON.stringify(result)).not.toContain(EDITION_ID);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it.each(["alreadyPublished", "inProgress"] as const)("maps %s to an ok result with no record count", async (outcome) => {
    mockBuildEdition.mockResolvedValue({ outcome, editionId: EDITION_ID, editionDate: "2026-11-09" });

    const result = await buildEditionNowAction();

    expect(result).toEqual({ ok: true, outcome, editionDate: "2026-11-09" });
    expect(JSON.stringify(result)).not.toContain(EDITION_ID);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("maps a failed build to an error carrying only the fixed code", async () => {
    mockBuildEdition.mockResolvedValue({
      outcome: "failed",
      editionId: EDITION_ID,
      editionDate: "2026-11-09",
      code: "below_floor",
    });

    const result = await buildEditionNowAction();

    expect(result).toEqual({ ok: false, error: "The edition build failed.", code: "below_floor" });
    expect(JSON.stringify(result)).not.toContain(EDITION_ID);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/access");
  });

  it("returns a failure rather than throwing if the builder breaks its never-throws contract", async () => {
    mockBuildEdition.mockRejectedValue(new Error("Failed query: select ... params: secret@example.org"));

    const result = await buildEditionNowAction();

    expect(result).toEqual({ ok: false, error: "The edition build failed.", code: "unknown" });
    expect(consoleOutput(consoleSpies)).not.toContain("secret@example.org");
  });
});
