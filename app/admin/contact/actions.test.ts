import { vi, describe, it, expect, beforeEach } from "vitest";

// Server Actions are independently callable, so the action must re-verify the
// admin session before looking anything up or sending. Mocking style mirrors
// app/admin/leads/actions.test.ts.
const { mockGetCookie, mockVerifySessionCookie, mockGetMessage, mockSendReply } = vi.hoisted(
  () => ({
    mockGetCookie: vi.fn(),
    mockVerifySessionCookie: vi.fn(),
    mockGetMessage: vi.fn(),
    mockSendReply: vi.fn(),
  })
);

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: mockGetCookie })),
}));
vi.mock("@/lib/admin-session", () => ({
  SESSION_COOKIE_NAME: "admin_session",
  verifySessionCookie: mockVerifySessionCookie,
}));
vi.mock("@/lib/contact", () => ({
  getContactMessageForReply: mockGetMessage,
}));
vi.mock("@/lib/email", () => ({
  sendContactReply: mockSendReply,
}));

import { replyToContactMessageAction } from "./actions";

const ORIGINAL = { email: "visitor@example.com", message: "Original text" };

describe("replyToContactMessageAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetCookie.mockReturnValue({ value: "cookie" });
    mockVerifySessionCookie.mockReturnValue(true);
    mockGetMessage.mockResolvedValue(ORIGINAL);
    mockSendReply.mockResolvedValue({ sent: true });
  });

  it("throws Unauthorized and sends nothing when the session is invalid", async () => {
    mockVerifySessionCookie.mockReturnValue(false);
    await expect(replyToContactMessageAction("id-1", "hi")).rejects.toThrow("Unauthorized");
    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("rejects empty and oversize bodies without sending", async () => {
    expect(await replyToContactMessageAction("id-1", "   ")).toEqual({
      ok: false,
      error: "Reply cannot be empty",
    });
    const tooLong = await replyToContactMessageAction("id-1", "x".repeat(10_001));
    expect(tooLong.ok).toBe(false);
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("returns Message not found for an unknown id", async () => {
    mockGetMessage.mockResolvedValue(undefined);
    expect(await replyToContactMessageAction("id-1", "hi")).toEqual({
      ok: false,
      error: "Message not found",
    });
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("sends to the address looked up from the DB, with the trimmed body", async () => {
    const result = await replyToContactMessageAction("id-1", "  Thanks!  ");
    expect(result).toEqual({ ok: true });
    expect(mockGetMessage).toHaveBeenCalledWith("id-1");
    expect(mockSendReply).toHaveBeenCalledWith({
      to: "visitor@example.com",
      originalMessage: "Original text",
      replyBody: "Thanks!",
    });
  });

  it("reports a failed send", async () => {
    mockSendReply.mockResolvedValue({ sent: false });
    const result = await replyToContactMessageAction("id-1", "hi");
    expect(result).toEqual({
      ok: false,
      error: "Reply was not sent — check RESEND_API_KEY / Resend logs.",
    });
  });

  it("returns a generic error and logs only a code when the lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetMessage.mockRejectedValue(new Error("Failed query: params: visitor@example.com"));
    const result = await replyToContactMessageAction("id-1", "hi");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("visitor@example.com");
    expect(mockSendReply).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("takes no recipient parameter (id and body only)", () => {
    expect(replyToContactMessageAction.length).toBe(2);
  });
});
