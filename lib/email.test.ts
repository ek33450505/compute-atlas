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

  it("sends to CONTACT_TO_EMAIL with NO replyTo, points at /admin/contact, and escapes html", async () => {
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
    // A replyTo would make a Gmail "Reply" go to the visitor from the
    // maintainer's personal address.
    expect(args.replyTo).toBeUndefined();
    expect(args.text).toContain("/admin/contact");
    expect(args.html).toContain("/admin/contact");
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
// sendContactReply
// ---------------------------------------------------------------------------
describe("sendContactReply", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resendSendMock.mockReset();
  });

  it("sends to the visitor from the Compute Atlas address with no replyTo/cc/bcc", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_FROM", "Compute Atlas <alerts@compute-atlas.com>");
    vi.stubEnv("CONTACT_TO_EMAIL", "private@example.com");
    resendSendMock.mockResolvedValue({ data: { id: "e1" }, error: null });

    const { sendContactReply } = await import("./email");
    const result = await sendContactReply({
      to: "visitor@example.com",
      originalMessage: "line one\nline two",
      replyBody: "Thanks for writing",
    });

    expect(result.sent).toBe(true);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("visitor@example.com");
    expect(args.from).toBe("Compute Atlas <alerts@compute-atlas.com>");
    expect(args.replyTo).toBeUndefined();
    expect(args.cc).toBeUndefined();
    expect(args.bcc).toBeUndefined();
    expect(args.subject).toBe("Re: your message to Compute Atlas");
    expect(args.text).toContain("Thanks for writing");
    expect(args.text).toContain("> line one\n> line two");
    expect(JSON.stringify(args)).not.toContain("private@example.com");
  });

  it("escapes html in both the reply and the quoted original", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockResolvedValue({ data: { id: "e1" }, error: null });

    const { sendContactReply } = await import("./email");
    await sendContactReply({
      to: "visitor@example.com",
      originalMessage: "<script>orig</script>",
      replyBody: "<b>reply</b>",
    });

    const args = resendSendMock.mock.calls[0][0];
    expect(args.html).toContain("&lt;b&gt;reply&lt;/b&gt;");
    expect(args.html).toContain("<blockquote>&lt;script&gt;orig&lt;/script&gt;</blockquote>");
    expect(args.html).not.toContain("<b>reply</b>");
    expect(args.html).not.toContain("<script>");
  });

  it("returns sent:false without calling Resend when RESEND_API_KEY is unset", async () => {
    const { sendContactReply } = await import("./email");
    const result = await sendContactReply({
      to: "visitor@example.com",
      originalMessage: "x",
      replyBody: "y",
    });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a personal address", "Ed <someone@gmail.com>"],
    ["a lookalike suffix domain", "Compute Atlas <x@compute-atlas.com.evil.com>"],
  ])("refuses to send when EMAIL_FROM is %s", async (_label, from) => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_FROM", from);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendContactReply } = await import("./email");
    const result = await sendContactReply({ to: "visitor@example.com", originalMessage: "x", replyBody: "y" });
    expect(result).toEqual({ sent: false });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("gmail");
    warn.mockRestore();
  });

  it("falls back to the default compute-atlas.com sender when EMAIL_FROM is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_FROM", undefined);
    resendSendMock.mockResolvedValue({ data: { id: "e1" }, error: null });
    const { sendContactReply } = await import("./email");
    const result = await sendContactReply({ to: "visitor@example.com", originalMessage: "x", replyBody: "y" });
    expect(result.sent).toBe(true);
    expect(resendSendMock.mock.calls[0][0].from).toBe("Compute Atlas <alerts@compute-atlas.com>");
  });

  it("accepts a bare compute-atlas.com EMAIL_FROM", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("EMAIL_FROM", "contact@compute-atlas.com");
    resendSendMock.mockResolvedValue({ data: { id: "e1" }, error: null });
    const { sendContactReply } = await import("./email");
    const result = await sendContactReply({ to: "visitor@example.com", originalMessage: "x", replyBody: "y" });
    expect(result.sent).toBe(true);
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
// sendWatchStartedEmail
// ---------------------------------------------------------------------------
// Sent instead of a confirm email on the auto-confirm path (see
// hasConfirmedSubscription in lib/subscribe.ts): the recipient IS a real,
// already-confirmed subscriber, so unlike sendSubmissionReviewedEmail this
// one DOES carry an unsubscribe link and List-Unsubscribe headers.
describe("sendWatchStartedEmail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resendSendMock.mockReset();
  });

  it("returns sent:false and does not call Resend when RESEND_API_KEY is unset", async () => {
    const { sendWatchStartedEmail } = await import("./email");
    const result = await sendWatchStartedEmail({
      email: "reader@example.com",
      targetLabel: "Some Facility",
      unsubscribeToken: "tok123",
    });
    expect(result.sent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("states plainly that no confirmation was needed, names the target, and carries a working unsubscribe link + headers", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const { sendWatchStartedEmail } = await import("./email");
    const result = await sendWatchStartedEmail({
      email: "reader@example.com",
      targetLabel: "Some Facility",
      unsubscribeToken: "tok123",
    });

    expect(result.sent).toBe(true);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("reader@example.com");
    expect(args.subject).toContain("Some Facility");
    expect(args.text.toLowerCase()).toContain("needed no confirmation");
    expect(args.text).toContain("Some Facility");
    expect(args.text).toContain("/api/subscribe/unsubscribe?token=tok123");
    expect(args.html).toContain("/api/subscribe/unsubscribe?token=tok123");
    expect(args.headers["List-Unsubscribe"]).toContain("/api/subscribe/unsubscribe?token=tok123");
    expect(args.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("escapes an unsafe targetLabel in the html body", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const { sendWatchStartedEmail } = await import("./email");
    await sendWatchStartedEmail({
      email: "reader@example.com",
      targetLabel: `<script>alert('x')</script>`,
      unsubscribeToken: "tok123",
    });

    const args = resendSendMock.mock.calls[0][0];
    expect(args.html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(args.html).not.toContain("<script>alert('x')</script>");
  });

  it("returns sent:false when the Resend call throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    resendSendMock.mockRejectedValue(new Error("network failure"));

    const { sendWatchStartedEmail } = await import("./email");
    const result = await sendWatchStartedEmail({
      email: "reader@example.com",
      targetLabel: "Some Facility",
      unsubscribeToken: "tok123",
    });
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
