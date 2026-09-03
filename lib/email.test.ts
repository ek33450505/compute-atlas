import { describe, it, expect, vi, afterEach } from "vitest";
import { generateToken } from "./email";

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------
// The Resend send path (sendConfirmEmail / sendChangeNotification) needs a
// mocked client and is deferred to the security/test unit (Wave C, unit 6).
describe("generateToken", () => {
  it("returns a base64url string of the expected length for a 256-bit token", () => {
    const token = generateToken();
    // 32 bytes base64url-encoded, no padding, is 43 characters.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns a different token on each call", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// sendContactEmail
// ---------------------------------------------------------------------------
const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

describe("sendContactEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resendSendMock.mockReset();
  });

  it("returns sent:false and does not call Resend when RESEND_API_KEY is unset", async () => {
    const { sendContactEmail } = await import("./email");
    const result = await sendContactEmail({
      name: "Jamie",
      email: "jamie@example.com",
      topic: "press",
      message: "hello there",
    });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("returns sent:false and does not call Resend when CONTACT_TO_EMAIL is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const { sendContactEmail } = await import("./email");
    const result = await sendContactEmail({
      name: "Jamie",
      email: "jamie@example.com",
      topic: "press",
      message: "hello there",
    });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends to CONTACT_TO_EMAIL with the submitter as replyTo, and escapes html", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.com");
    resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const { sendContactEmail } = await import("./email");
    const result = await sendContactEmail({
      name: "<b>Jamie</b>",
      email: "jamie@example.com",
      topic: "correction",
      message: "some message",
    });

    expect(result.sent).toBe(true);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("maintainer@example.com");
    expect(args.replyTo).toBe("jamie@example.com");
    expect(args.subject).toBe("Compute Atlas contact — correction");
    expect(args.html).toContain("&lt;b&gt;Jamie&lt;/b&gt;");
    expect(args.html).not.toContain("<b>Jamie</b>");
  });

  it("returns sent:false when the Resend call throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.com");
    resendSendMock.mockRejectedValue(new Error("network failure"));

    const { sendContactEmail } = await import("./email");
    const result = await sendContactEmail({
      name: "Jamie",
      email: "jamie@example.com",
      topic: "other",
      message: "some message",
    });
    expect(result.sent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendBulkAccessEmail
// ---------------------------------------------------------------------------
describe("sendBulkAccessEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resendSendMock.mockReset();
  });

  it("returns sent:false and does not call Resend when RESEND_API_KEY is unset", async () => {
    const { sendBulkAccessEmail } = await import("./email");
    const result = await sendBulkAccessEmail({ email: "reader@example.com", confirmToken: "tok123" });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends to the requester with a confirm link built from the token, and explains why the flow exists", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const { sendBulkAccessEmail } = await import("./email");
    const result = await sendBulkAccessEmail({ email: "reader@example.com", confirmToken: "tok123" });

    expect(result.sent).toBe(true);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("reader@example.com");
    expect(args.subject).toContain("bulk API access");
    expect(args.text).toContain("/api/access/confirm?token=tok123");
    expect(args.html).toContain("/api/access/confirm?token=tok123");
    // Ed's explicit requirement (2026-09-03): body must say plainly why this
    // exists — not to gatekeep the data, and /data remains a zero-login path.
    expect(args.text).toContain("not to gatekeep the data");
    expect(args.text).toContain("/data");
  });

  it("returns sent:false when the Resend call throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockRejectedValue(new Error("network failure"));

    const { sendBulkAccessEmail } = await import("./email");
    const result = await sendBulkAccessEmail({ email: "reader@example.com", confirmToken: "tok123" });
    expect(result.sent).toBe(false);
  });
});
