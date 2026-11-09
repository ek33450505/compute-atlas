// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { ONE_CLICK_BODY, ONE_CLICK_READ_TIMEOUT_MS, isOneClickUnsubscribe } from "./one-click-unsubscribe";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x/unsubscribe?token=t", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** A request whose body stream is the given one, with no declared content-length. */
function streamed(stream: ReadableStream<Uint8Array>): Request {
  return post(stream);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isOneClickUnsubscribe", () => {
  it("is true for exactly the RFC 8058 marker", async () => {
    expect(await isOneClickUnsubscribe(post(ONE_CLICK_BODY))).toBe(true);
  });

  it("is false for an empty or absent body (a page form)", async () => {
    expect(await isOneClickUnsubscribe(post(""))).toBe(false);
    expect(await isOneClickUnsubscribe(post(null))).toBe(false);
  });

  it("is false for different text of the same length and for case variants", async () => {
    expect(await isOneClickUnsubscribe(post("x".repeat(ONE_CLICK_BODY.length)))).toBe(false);
    expect(await isOneClickUnsubscribe(post("List-Unsubscribe=one-click"))).toBe(false);
  });

  it("is false when the declared content-length exceeds the marker, without reading the body", async () => {
    const getReader = vi.fn();
    const request = {
      headers: new Headers({ "content-length": String(ONE_CLICK_BODY.length + 1) }),
      body: { getReader },
    } as unknown as Request;
    expect(await isOneClickUnsubscribe(request)).toBe(false);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("is false when the actual body is one byte longer than the marker", async () => {
    expect(await isOneClickUnsubscribe(post(`${ONE_CLICK_BODY}x`))).toBe(false);
    expect(await isOneClickUnsubscribe(post(`${ONE_CLICK_BODY}&x=1`))).toBe(false);
  });

  it("is false for a long streamed body that declares no length, reading only a bounded prefix", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("y".repeat(100)));
      },
    });
    expect(await isOneClickUnsubscribe(streamed(stream))).toBe(false);
    expect(pulls).toBeLessThan(10);
  });

  it("is false within ~ONE_CLICK_READ_TIMEOUT_MS for a stream that never delivers or closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    let settled: boolean | undefined;
    const pending = isOneClickUnsubscribe(streamed(stalled)).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(ONE_CLICK_READ_TIMEOUT_MS - 100);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(settled).toBe(false);
  });

  it("is false, and does not throw, when the reader errors", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });
    await expect(isOneClickUnsubscribe(streamed(broken))).resolves.toBe(false);
  });

  it("never throws, even when the request cannot yield a reader", async () => {
    const noReader = { headers: new Headers(), body: { getReader: () => undefined } } as unknown as Request;
    await expect(isOneClickUnsubscribe(noReader)).resolves.toBe(false);
    const garbageLength = {
      headers: new Headers({ "content-length": "not-a-number" }),
      body: null,
    } as unknown as Request;
    await expect(isOneClickUnsubscribe(garbageLength)).resolves.toBe(false);
  });
});
