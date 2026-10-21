import { afterEach, describe, expect, it, vi } from "vitest";

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import { Resend } from "resend";
import { safeErrorCode, sendViaResend } from "./email";

const payload = { from: "a@compute-atlas.com", to: "x@example.com", subject: "s", text: "t" };

describe("sendViaResend result", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resendSendMock.mockReset();
  });

  it("surfaces the Resend id on success and passes the payload (headers included) through", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    resendSendMock.mockResolvedValue({ data: { id: "re_123" }, error: null });
    const headers = { "List-Unsubscribe": "<https://x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    const result = await sendViaResend("L", "skip", { ...payload, headers });
    expect(result).toEqual({ sent: true, resendId: "re_123" });
    expect(resendSendMock).toHaveBeenCalledWith({ ...payload, headers });
  });

  it("returns resendId null when Resend returns no data", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    resendSendMock.mockResolvedValue({ data: null, error: null });
    expect(await sendViaResend("L", "skip", payload)).toEqual({ sent: true, resendId: null });
  });

  it("returns the sanitized error name on result.error and logs only the name", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resendSendMock.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "bad address x@example.com" },
    });
    const result = await sendViaResend("Lbl", "skip", payload);
    expect(result).toEqual({ sent: false, errorCode: "validation_error" });
    expect(errSpy).toHaveBeenCalledWith("Lbl failed:", "validation_error");
  });

  it("returns the thrown Error name", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("network failure to x@example.com");
    err.name = "FetchError";
    resendSendMock.mockRejectedValue(err);
    expect(await sendViaResend("L", "skip", payload)).toEqual({ sent: false, errorCode: "FetchError" });
  });

  it("reports unknown for a non-Error throw", async () => {
    vi.stubEnv("RESEND_API_KEY", "k");
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendSendMock.mockRejectedValue("boom");
    expect(await sendViaResend("L", "skip", payload)).toEqual({ sent: false, errorCode: "unknown" });
  });

  it("skips with no_key and warns when RESEND_API_KEY is unset", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendViaResend("L", "skip msg", payload);
    expect(result).toEqual({ sent: false, errorCode: "no_key", skipped: "no_key" });
    expect(warnSpy).toHaveBeenCalledWith("skip msg");
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("sendViaResend client construction", () => {
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
    const result = await sendViaResend("Lbl", "skip", payload);
    expect(result).toEqual({ sent: false, errorCode: "unknown" });
    expect(errSpy).toHaveBeenCalledWith("Lbl failed:", "unknown");
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
