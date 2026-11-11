// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.fn();
vi.mock("@/lib/paypal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/paypal")>();
  return { ...actual, verifyWebhookSignature: (...a: unknown[]) => verify(...a) };
});
const processEvent = vi.fn();
vi.mock("@/lib/commercial-activation", () => ({
  processPaypalEvent: (...a: unknown[]) => processEvent(...a),
}));

import { PayPalApiError, PayPalConfigError } from "@/lib/paypal";
import { GET, POST, TERMINAL_404_MIN_AGE_MS } from "./route";

const SECRET_BODY = "SECRET-BODY-MARKER buyer@example.com";

function post(body: string | ReadableStream<Uint8Array> = SECRET_BODY, headers: Record<string, string> = {}): Request {
  return new Request("https://www.compute-atlas.com/api/paypal/webhook", {
    method: "POST",
    body,
    headers,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  } as RequestInit);
}

function expectNoStore(res: Response) {
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("cdn-cache-control")).toContain("no-store");
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  verify.mockReset();
  processEvent.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const loggedText = () => JSON.stringify(errSpy.mock.calls);

describe("POST /api/paypal/webhook", () => {
  it("answers 403 when the tier is off, before any work", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "false");
    const res = await POST(post());
    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 413 for a streamed body over the cap, ignoring Content-Length", async () => {
    const chunk = new Uint8Array(300 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const res = await POST(post(stream, { "content-length": "10" }));
    expect(res.status).toBe(413);
    expectNoStore(res);
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 413 on a declared oversize Content-Length", async () => {
    const res = await POST(post("x", { "content-length": String(600 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("answers 400 when unverified and never processes", async () => {
    verify.mockResolvedValue({ verified: false, reason: "body_shape" });
    const res = await POST(post());
    expect(res.status).toBe(400);
    expectNoStore(res);
    expect(processEvent).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain("SECRET-BODY-MARKER");
  });

  it("logs the reason and PayPal codes on unverified, never a message", async () => {
    verify.mockResolvedValue({ verified: false, reason: "paypal_4xx", status: 400, paypalName: "INVALID_REQUEST", debugId: "dbg9" });
    await POST(post());
    expect(loggedText()).toContain("reason=paypal_4xx status=400 paypalName=INVALID_REQUEST debugId=dbg9");
    errSpy.mockClear();
    verify.mockResolvedValue({ verified: false, reason: "verdict_failure", verdict: "FAILURE" });
    await POST(post());
    expect(loggedText()).toContain("reason=verdict_failure verdict=FAILURE");
  });

  it("answers 500 when verification throws, logging codes only", async () => {
    verify.mockRejectedValue(new PayPalApiError(503, "INTERNAL", "dbg123"));
    const res = await POST(post());
    expect(res.status).toBe(500);
    expectNoStore(res);
    expect(processEvent).not.toHaveBeenCalled();
    const logged = loggedText();
    expect(logged).toContain("503");
    expect(logged).toContain("INTERNAL");
    expect(logged).toContain("dbg123");
    expect(logged).not.toContain("SECRET-BODY-MARKER");
  });

  it("answers 500 when processing throws", async () => {
    verify.mockResolvedValue({ verified: true, event: { id: "WH-1" } });
    processEvent.mockRejectedValue(new Error("boom buyer@example.com"));
    const res = await POST(post());
    expect(res.status).toBe(500);
    expectNoStore(res);
    expect(loggedText()).not.toContain("buyer@example.com");
    expect(loggedText()).not.toContain("SECRET-BODY-MARKER");
  });

  it("logs event id and type on processing failure, never the body", async () => {
    verify.mockResolvedValue({ verified: true, event: { id: "WH-9", event_type: "PAYMENT.SALE.COMPLETED", resource: { email: "buyer@example.com" } } });
    processEvent.mockRejectedValue(new Error("x"));
    await POST(post());
    const logged = loggedText();
    expect(logged).toContain("WH-9");
    expect(logged).toContain("PAYMENT.SALE.COMPLETED");
    expect(logged).not.toContain("buyer@example.com");
    expect(logged).not.toContain("SECRET-BODY-MARKER");
  });

  it("logs a well-formed transmission id on unverified, omits a malformed one", async () => {
    verify.mockResolvedValue({ verified: false, reason: "body_shape" });
    await POST(post(SECRET_BODY, { "paypal-transmission-id": "abc-123" }));
    expect(loggedText()).toContain("abc-123");
    errSpy.mockClear();
    await POST(post(SECRET_BODY, { "paypal-transmission-id": "bad id;<x>" }));
    expect(loggedText()).not.toContain("bad id");
  });

  it("answers 200 terminal when PayPal says 404, and 500 for other failures", async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    verify.mockResolvedValue({ verified: true, event: { id: "WH-4", event_type: "T", create_time: old } });
    processEvent.mockRejectedValueOnce(new PayPalApiError(404, "RESOURCE_NOT_FOUND", "d1"));
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, terminal: true });
    expect(loggedText()).toContain("terminal");
    expect(loggedText()).toContain("WH-4");
    expectNoStore(res);

    const failures = [
      new PayPalApiError(0, undefined, undefined),
      new PayPalApiError(401, "AUTH", "d"),
      new PayPalApiError(429, "RATE", "d"),
      new PayPalApiError(503, "DOWN", "d"),
      new PayPalConfigError("PAYPAL_X"),
      new Error("db"),
    ];
    for (const err of failures) {
      processEvent.mockRejectedValueOnce(err);
      expect((await POST(post())).status).toBe(500);
    }
  });

  it("treats a 404 as terminal only for an event older than the threshold", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const cases: Array<[unknown, number]> = [
      [ago(TERMINAL_404_MIN_AGE_MS + 60_000), 200],
      [ago(TERMINAL_404_MIN_AGE_MS - 60_000), 500],
      [ago(0), 500],
      [undefined, 500],
      ["not a date", 500],
      [12345, 500],
    ];
    for (const [create_time, status] of cases) {
      verify.mockResolvedValue({ verified: true, event: { id: "WH-5", event_type: "T", create_time } });
      processEvent.mockRejectedValueOnce(new PayPalApiError(404, "RESOURCE_NOT_FOUND", "d"));
      expect((await POST(post())).status, String(create_time)).toBe(status);
    }
  });

  it("answers 200 and processes exactly the verified event object", async () => {
    const event = { id: "WH-2", event_type: "BILLING.SUBSCRIPTION.ACTIVATED" };
    verify.mockResolvedValue({ verified: true, event });
    processEvent.mockResolvedValue({ kind: "ignored" });
    const res = await POST(post(SECRET_BODY, { "paypal-transmission-id": "t" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expectNoStore(res);
    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(processEvent.mock.calls[0][0]).toBe(event);
    const [headers, raw] = verify.mock.calls[0];
    expect(headers.get("paypal-transmission-id")).toBe("t");
    expect(raw).toBe(SECRET_BODY);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/paypal/webhook", () => {
  it("is a no-store 405 with Allow", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
    expectNoStore(res);
  });
});
