// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.fn();
const processEvent = vi.fn();
const sideEffects = vi.fn();
const makeSideEffects = vi.fn();
const fakeClient = { fake: "client" };
const fakeDb = { fake: "db" };

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return {
    ...actual,
    getStripeClient: () => fakeClient,
    verifyStripeWebhook: (...a: unknown[]) => verify(...a),
  };
});
vi.mock("@/lib/commercial-grants", () => ({
  processStripeEvent: (...a: unknown[]) => processEvent(...a),
}));
vi.mock("@/lib/commercial-actions", () => ({
  makeCommercialSideEffects: (...a: unknown[]) => makeSideEffects(...a),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

import { StripeConfigError, StripeSignatureError } from "@/lib/stripe";
import { GET, POST } from "./route";

const EVENT = { id: "evt_1", type: "invoice.paid", data: { object: { customer_email: "buyer@example.test" } } };
// Deliberately not canonical JSON: re-serializing it would change the bytes.
const RAW = '{ "id":  "evt_1",   "type": "invoice.paid" }';

function webhook(body: string = RAW, headers: Record<string, string> = {}): Request {
  return new Request("https://www.compute-atlas.com/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=secretsig", ...headers },
    body,
  });
}

function noStore(res: Response) {
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("cdn-cache-control")).toContain("no-store");
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  verify.mockReturnValue(EVENT);
  processEvent.mockResolvedValue({ kind: "ignored" });
  makeSideEffects.mockReturnValue(sideEffects);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("POST /api/stripe/webhook", () => {
  it("is not available with the flag off and touches nothing", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    const res = await POST(webhook());
    expect(res.status).toBe(403);
    noStore(res);
    expect(verify).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("answers GET with a no-store 405 naming POST", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    noStore(res);
  });

  it("rejects an oversize content-length with 413 before verification", async () => {
    const res = await POST(webhook(RAW, { "content-length": String(512 * 1024 + 1) }));
    expect(res.status).toBe(413);
    noStore(res);
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects an oversize body with 413 by its byte length", async () => {
    // 3 bytes per char: 175k chars is under the cap in characters, over it in bytes.
    const res = await POST(webhook("€".repeat(175_000)));
    expect(res.status).toBe(413);
    noStore(res);
    expect(verify).not.toHaveBeenCalled();
  });

  it("is 503 when Stripe is not configured, with no detail", async () => {
    verify.mockImplementation(() => {
      throw new StripeConfigError("STRIPE_WEBHOOK_SECRET");
    });
    const res = await POST(webhook());
    expect(res.status).toBe(503);
    noStore(res);
    expect(JSON.stringify(await res.json())).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("is 400 on a bad signature and echoes no detail", async () => {
    verify.mockImplementation(() => {
      throw new StripeSignatureError("No signatures found matching the expected signature");
    });
    const res = await POST(webhook());
    expect(res.status).toBe(400);
    noStore(res);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("passes the raw text, not re-serialized JSON, to verification", async () => {
    await POST(webhook());
    expect(verify).toHaveBeenCalledTimes(1);
    const [bytes, sig, client] = verify.mock.calls[0];
    expect(Buffer.from(bytes as Uint8Array).toString("utf8")).toBe(RAW);
    expect(sig).toBe("t=1,v1=secretsig");
    expect(client).toBe(fakeClient);
  });

  it("keeps a leading BOM and non-ASCII bytes exactly", async () => {
    const body = "\uFEFF" + '{"a":"€"}';
    await POST(webhook(body));
    expect(Buffer.from(verify.mock.calls[0][0] as Uint8Array).equals(Buffer.from(body, "utf8"))).toBe(true);
  });

  it("rejects a streamed oversize body with no content-length, cancelling the stream", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(100 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 100) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request("https://www.compute-atlas.com/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=secretsig" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
    noStore(res);
    expect(verify).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(10);
  });

  it("accepts a body exactly at the cap", async () => {
    const res = await POST(webhook("a".repeat(512 * 1024)));
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect((verify.mock.calls[0][0] as Uint8Array).byteLength).toBe(512 * 1024);
  });

  it("is 500 for a non-Error rejection, logging the code and id/type but not the value", async () => {
    processEvent.mockRejectedValue("boom");
    const res = await POST(webhook());
    expect(res.status).toBe(500);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("unknown");
    expect(logged).toContain("evt_1");
    expect(logged).toContain("invoice.paid");
    expect(logged).not.toContain("boom");
  });

  it("processes a verified event and answers 200", async () => {
    const res = await POST(webhook());
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual({ received: true });
    expect(makeSideEffects).toHaveBeenCalledWith({ db: fakeDb, stripe: fakeClient });
    expect(processEvent).toHaveBeenCalledWith(EVENT, {
      db: fakeDb,
      stripe: fakeClient,
      beforeComplete: sideEffects,
    });
  });

  it("answers 200 for a duplicate", async () => {
    processEvent.mockResolvedValue({ kind: "duplicate" });
    const res = await POST(webhook());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it("is 500 when processing throws, logging only the redacted code and event id/type", async () => {
    const err = Object.assign(
      new Error(`Failed query: insert ... params: buyer@example.test, tok_secret ${RAW}`),
      { code: "23505" }
    );
    processEvent.mockRejectedValue(err);
    const res = await POST(webhook());
    expect(res.status).toBe(500);
    noStore(res);
    expect(await res.json()).toEqual({ error: "processing failed" });

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("23505");
    expect(logged).toContain("evt_1");
    expect(logged).toContain("invoice.paid");
    for (const secret of ["buyer@example.test", "tok_secret", "secretsig", "Failed query", '"id":']) {
      expect(logged).not.toContain(secret);
    }
  });
});
