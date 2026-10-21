import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import { Resend } from "resend";
import { safeErrorCode, sendContactEmail, sendStateDigestEmail } from "./email";

// sendViaResend is module-private, so its result mapping is exercised through
// public senders: sendContactEmail (plain payload) and sendStateDigestEmail (headers).
const input = { name: "N", email: "v@example.com", topic: "T", message: "M" };
const send = () => sendContactEmail(input);
const change = {
  facilityName: "F",
  facilitySlug: "f",
  changeLabel: "record updated",
  status: "Operational",
  unsubscribeToken: "tok",
};
const LABEL = "sendContactEmail";

describe("sendViaResend result (via public senders)", () => {
  beforeEach(() => {
    vi.stubEnv("CONTACT_TO_EMAIL", "x@example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resendSendMock.mockReset();
  });

  it("surfaces the Resend id on success and passes the payload (headers included) through", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    resendSendMock.mockResolvedValue({ data: { id: "re_123" }, error: null });
    const result = await sendStateDigestEmail("x@example.com", "Texas", [change]);
    expect(result).toEqual({ sent: true, resendId: "re_123" });
    expect(resendSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "x@example.com",
        headers: {
          "List-Unsubscribe": expect.stringMatching(/^<http.*\/api\/subscribe\/unsubscribe\?token=tok>$/),
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    );
  });

  it("returns resendId null when Resend returns no data", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    resendSendMock.mockResolvedValue({ data: null, error: null });
    expect(await send()).toEqual({ sent: true, resendId: null });
  });

  it("returns the sanitized error name on result.error and logs only the name", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resendSendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "bad address x@example.com" },
    });
    const result = await send();
    expect(result).toEqual({ sent: false, errorCode: "validation_error" });
    expect(errSpy).toHaveBeenCalledWith(`${LABEL} failed:`, "validation_error");
  });

  it("returns the thrown Error name", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("network failure to x@example.com");
    err.name = "FetchError";
    resendSendMock.mockRejectedValue(err);
    expect(await send()).toEqual({ sent: false, errorCode: "FetchError" });
  });

  it("reports unknown for a non-Error throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendSendMock.mockRejectedValue("boom");
    expect(await send()).toEqual({ sent: false, errorCode: "unknown" });
  });

  it("skips with no_key and warns when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await send();
    expect(result).toEqual({ sent: false, errorCode: "no_key", skipped: "no_key" });
    expect(warnSpy).toHaveBeenCalledWith("RESEND_API_KEY not set — skipping contact email send");
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("sendViaResend client construction (via public senders)", () => {
  beforeEach(() => {
    vi.stubEnv("CONTACT_TO_EMAIL", "x@example.com");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns a failed result with a sanitized code when the Resend constructor throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("bad key for x@example.com");
    err.name = "has space";
    vi.mocked(Resend).mockImplementationOnce(function ThrowingResend() {
      throw err;
    });
    const result = await send();
    expect(result).toEqual({ sent: false, errorCode: "unknown" });
    expect(errSpy).toHaveBeenCalledWith(`${LABEL} failed:`, "unknown");
  });
});

describe("safeErrorCode", () => {
  it("passes identifier-shaped names through", () => {
    expect(safeErrorCode("rate_limit_exceeded")).toBe("rate_limit_exceeded");
    expect(safeErrorCode("a".repeat(64))).toBe("a".repeat(64));
  });

  it.each([
    ["spaces", "has space"],
    ["an at sign", "x@example.com"],
    ["over 64 chars", "a".repeat(65)],
    ["empty", ""],
    ["non-string", 42],
    ["undefined", undefined],
  ])("rejects a name with %s", (_label, value) => {
    expect(safeErrorCode(value)).toBe("unknown");
  });
});
