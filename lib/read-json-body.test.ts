import { describe, it, expect } from "vitest";

import { MAX_JSON_BODY_BYTES, readJsonBody } from "@/lib/read-json-body";

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    body,
    headers,
    // Required by undici for a streamed body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("readJsonBody", () => {
  it("parses a normal payload unchanged", async () => {
    const result = await readJsonBody(post(JSON.stringify({ a: 1, s: "é" })));
    expect(result).toEqual({ ok: true, body: { a: 1, s: "é" } });
  });

  it("reports invalid_json for malformed and empty bodies", async () => {
    expect(await readJsonBody(post("{nope"))).toEqual({ ok: false, reason: "invalid_json" });
    expect(await readJsonBody(post(null))).toEqual({ ok: false, reason: "invalid_json" });
  });

  it("rejects an oversize declared content-length without reading", async () => {
    const result = await readJsonBody(
      post("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) })
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects an oversize body with no content-length (streamed)", async () => {
    const chunk = new Uint8Array(1024).fill(0x20);
    const chunks = Array.from({ length: 80 }, () => chunk); // 80 KiB
    const req = post(streamOf(chunks));
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects when content-length lies low but the stream is large", async () => {
    const result = await readJsonBody(
      post(" ".repeat(MAX_JSON_BODY_BYTES + 10), { "content-length": "2" })
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("honours a custom maxBytes and counts bytes, not characters", async () => {
    const body = JSON.stringify("é".repeat(10)); // 22 bytes, 12 chars
    expect(await readJsonBody(post(body), { maxBytes: 21 })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect((await readJsonBody(post(body), { maxBytes: 22 })).ok).toBe(true);
  });

  it("decodes a multibyte character split across chunks", async () => {
    const req = post(streamOf([new Uint8Array([0x22, 0xc3]), new Uint8Array([0xa9, 0x22])]));
    expect(await readJsonBody(req)).toEqual({ ok: true, body: "é" });
  });
});
