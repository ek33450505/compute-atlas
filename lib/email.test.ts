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

// ---------------------------------------------------------------------------
// sendSubmissionReviewedEmail
// ---------------------------------------------------------------------------
// This recipient never subscribed to anything — the template-invariant tests
// below exist because this repo shipped exactly that mistake once already
// (a state digest inherited a facility-watch template's copy and an
// unsubscribe link that lied to its recipients).
describe("sendSubmissionReviewedEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resendSendMock.mockReset();
  });

  it("returns sent:false and does not call Resend when RESEND_API_KEY is unset", async () => {
    const { sendSubmissionReviewedEmail } = await import("./email");
    const result = await sendSubmissionReviewedEmail({
      email: "reader@example.com",
      decision: "approved",
      facilityName: "Example Facility",
      facilitySlug: "example-facility",
    });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  describe("decision: approved", () => {
    it("sends to the recipient with a link built from facilitySlug", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

      const { sendSubmissionReviewedEmail } = await import("./email");
      const result = await sendSubmissionReviewedEmail({
        email: "reader@example.com",
        decision: "approved",
        facilityName: "Example Facility",
        facilitySlug: "example-facility",
      });

      expect(result.sent).toBe(true);
      expect(resendSendMock).toHaveBeenCalledTimes(1);
      const args = resendSendMock.mock.calls[0][0];
      expect(args.to).toBe("reader@example.com");
      expect(args.html).toContain("/facilities/example-facility");
      expect(args.text).toContain("/facilities/example-facility");
    });
  });

  describe("decision: rejected", () => {
    it("sends non-accusatory copy pointing to /contribute, with different copy from the approved case", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

      const { sendSubmissionReviewedEmail } = await import("./email");
      const result = await sendSubmissionReviewedEmail({
        email: "reader@example.com",
        decision: "rejected",
        facilityName: "Example Facility",
      });

      expect(result.sent).toBe(true);
      const args = resendSendMock.mock.calls[0][0];
      expect(args.to).toBe("reader@example.com");
      expect(args.html).toContain("/contribute");
      // Different copy from the approved case — never claims publication.
      expect(args.html).not.toContain("is now live");
      expect(args.html).not.toContain("has been reviewed and published");
      // Non-accusatory: never implies the submitter did something wrong, and
      // never promises a human reply.
      expect(args.html.toLowerCase()).not.toMatch(/you (lied|falsified|fabricated)/);
      expect(args.html.toLowerCase()).not.toContain("will get back to you");
    });

    it("falls back to a neutral label when facilityName is the generic fallback (no real name available)", async () => {
      vi.stubEnv("RESEND_API_KEY", "test-key");
      resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

      const { sendSubmissionReviewedEmail } = await import("./email");
      await sendSubmissionReviewedEmail({
        email: "reader@example.com",
        decision: "rejected",
        facilityName: "your submission",
      });

      const args = resendSendMock.mock.calls[0][0];
      // Reads as a coherent sentence either way — see lib/submissions.ts's
      // facilityLabelForRejection for when this fallback is passed in.
      expect(args.text).toContain("reviewing your submission");
    });
  });

  describe("template invariants (both decisions)", () => {
    it.each(["approved", "rejected"] as const)(
      "decision=%s: no unsubscribe link, no List-Unsubscribe header, no subscription-style phrasing",
      async (decision) => {
        vi.stubEnv("RESEND_API_KEY", "test-key");
        resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

        const { sendSubmissionReviewedEmail } = await import("./email");
        await sendSubmissionReviewedEmail({
          email: "reader@example.com",
          decision,
          facilityName: "Example Facility",
          facilitySlug: "example-facility",
        });

        const args = resendSendMock.mock.calls[0][0];
        expect(args.html).not.toContain("/api/subscribe/unsubscribe");
        expect(args.text).not.toContain("/api/subscribe/unsubscribe");
        expect(args.headers?.["List-Unsubscribe"]).toBeUndefined();
        expect(args.html).not.toContain("you asked to be notified");
        expect(args.text).not.toContain("you asked to be notified");
        expect(args.html).not.toContain("the record you're watching");
        expect(args.text).not.toContain("the record you're watching");
        // States plainly this is the only email and the address is deleted.
        expect(args.text).toContain("only email");
        expect(args.text.toLowerCase()).toContain("deleted");
      }
    );

    it.each(["approved", "rejected"] as const)(
      "decision=%s: escapes an unsafe facilityName in the html body",
      async (decision) => {
        vi.stubEnv("RESEND_API_KEY", "test-key");
        resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

        const { sendSubmissionReviewedEmail } = await import("./email");
        await sendSubmissionReviewedEmail({
          email: "reader@example.com",
          decision,
          facilityName: `<script>alert('x')</script> & Sons`,
          facilitySlug: "example-facility",
        });

        const args = resendSendMock.mock.calls[0][0];
        expect(args.html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; Sons");
        expect(args.html).not.toContain("<script>alert('x')</script>");
      }
    );
  });
});
