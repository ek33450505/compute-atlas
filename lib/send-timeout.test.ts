import { afterEach, describe, expect, it, vi } from "vitest";

import { sendWithTimeout } from "@/lib/send-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("sendWithTimeout", () => {
  it("passes through a send that settles in time and clears its timer", async () => {
    vi.useFakeTimers();
    const result = await sendWithTimeout(async () => ({ sent: true, id: "x" }) as never, 1000);
    expect(result).toMatchObject({ sent: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves send_timeout when the send hangs", async () => {
    vi.useFakeTimers();
    const pending = sendWithTimeout(() => new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ sent: false, errorCode: "send_timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the send rejects", async () => {
    vi.useFakeTimers();
    await expect(
      sendWithTimeout(() => Promise.reject(new Error("boom")), 1000)
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the send throws synchronously", async () => {
    vi.useFakeTimers();
    await expect(
      sendWithTimeout(() => {
        throw new Error("sync boom");
      }, 1000)
    ).rejects.toThrow("sync boom");
    expect(vi.getTimerCount()).toBe(0);
  });
});
