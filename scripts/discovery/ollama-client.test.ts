import { describe, it, expect, vi, afterEach } from "vitest";

import { callOllama } from "./ollama-client";

function makeFetch(responseBody: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    } as Response;
  });
}

function lastRequestBody(fetchImpl: ReturnType<typeof makeFetch>): Record<string, unknown> {
  const call = fetchImpl.mock.calls[0];
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("callOllama", () => {
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalModel = process.env.OLLAMA_VERIFY_MODEL;
  const originalTimeoutMs = process.env.OLLAMA_TIMEOUT_MS;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.OLLAMA_VERIFY_MODEL;
    else process.env.OLLAMA_VERIFY_MODEL = originalModel;
    if (originalTimeoutMs === undefined) delete process.env.OLLAMA_TIMEOUT_MS;
    else process.env.OLLAMA_TIMEOUT_MS = originalTimeoutMs;
  });

  it("posts to /api/chat, never /api/generate", async () => {
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "sys", userPrompt: "user", jsonSchema: { type: "object" }, fetchImpl });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/chat$/);
    expect(String(url)).not.toMatch(/\/api\/generate/);
  });

  it("always sets num_ctx explicitly, defaulting to 32768", async () => {
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });

    const body = lastRequestBody(fetchImpl);
    expect((body.options as { num_ctx: number }).num_ctx).toBe(32768);
  });

  it("passes a custom numCtx through unchanged", async () => {
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl, numCtx: 8192 });

    const body = lastRequestBody(fetchImpl);
    expect((body.options as { num_ctx: number }).num_ctx).toBe(8192);
  });

  it("passes the jsonSchema through as `format` exactly", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: schema, fetchImpl });

    const body = lastRequestBody(fetchImpl);
    expect(body.format).toEqual(schema);
  });

  it("sends temperature 0 and both messages in the request body", async () => {
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "system text", userPrompt: "user text", jsonSchema: {}, fetchImpl });

    const body = lastRequestBody(fetchImpl);
    expect((body.options as { temperature: number }).temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ]);
  });

  it("parses valid message.content into the expected object", async () => {
    const fetchImpl = makeFetch({ message: { content: '{"verdict":"supports","quote":"x"}' } });
    const result = await callOllama<{ verdict: string; quote: string }>({
      systemPrompt: "s",
      userPrompt: "u",
      jsonSchema: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, data: { verdict: "supports", quote: "x" } });
  });

  it("returns ok:false on empty message.content (the /api/generate-trap regression guard)", async () => {
    const fetchImpl = makeFetch({ message: { content: "" } });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on whitespace-only message.content", async () => {
    const fetchImpl = makeFetch({ message: { content: "   \n\t  " } });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when message.content is entirely absent", async () => {
    const fetchImpl = makeFetch({ message: {} });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (not a throw) on malformed JSON in message.content", async () => {
    const fetchImpl = makeFetch({ message: { content: "{not valid json" } });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false with reason invalid_content_shape when message.content parses to a JSON array", async () => {
    const fetchImpl = makeFetch({ message: { content: "[1,2,3]" } });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_content_shape");
  });

  it("returns ok:false with reason invalid_content_shape when message.content parses to null", async () => {
    const fetchImpl = makeFetch({ message: { content: "null" } });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_content_shape");
  });

  it("returns ok:false with reason invalid_content_shape when message.content parses to a bare string or number", async () => {
    const stringFetch = makeFetch({ message: { content: '"just a string"' } });
    const stringResult = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl: stringFetch });
    expect(stringResult.ok).toBe(false);
    if (!stringResult.ok) expect(stringResult.reason).toBe("invalid_content_shape");

    const numberFetch = makeFetch({ message: { content: "42" } });
    const numberResult = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl: numberFetch });
    expect(numberResult.ok).toBe(false);
    if (!numberResult.ok) expect(numberResult.reason).toBe("invalid_content_shape");
  });

  it("returns ok:false (not a throw) on a network error / rejected fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (not a throw) on a non-2xx HTTP response", async () => {
    const fetchImpl = makeFetch({ error: "model not found" }, 404);
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false (not a throw) when the response body itself isn't valid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      } as unknown as Response;
    });
    const result = await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("ignores message.thinking and still parses content correctly", async () => {
    const fetchImpl = makeFetch({
      message: { content: '{"verdict":"supports"}', thinking: "reasoning trace ".repeat(50) },
    });
    const result = await callOllama<{ verdict: string }>({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
    expect(result).toEqual({ ok: true, data: { verdict: "supports" } });
  });

  it("defaults baseUrl to http://localhost:11434 and model to gpt-oss:20b", async () => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_VERIFY_MODEL;
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://localhost:11434/api/chat");
    const body = lastRequestBody(fetchImpl);
    expect(body.model).toBe("gpt-oss:20b");
  });

  it("resolves baseUrl and model from env vars when not passed explicitly", async () => {
    process.env.OLLAMA_BASE_URL = "http://custom-host:11434";
    process.env.OLLAMA_VERIFY_MODEL = "qwen2.5:7b";
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://custom-host:11434/api/chat");
    const body = lastRequestBody(fetchImpl);
    expect(body.model).toBe("qwen2.5:7b");
  });

  it("prefers explicit opts.baseUrl/model over env vars", async () => {
    process.env.OLLAMA_BASE_URL = "http://env-host:11434";
    process.env.OLLAMA_VERIFY_MODEL = "env-model";
    const fetchImpl = makeFetch({ message: { content: "{}" } });
    await callOllama({
      baseUrl: "http://explicit-host:11434",
      model: "explicit-model",
      systemPrompt: "s",
      userPrompt: "u",
      jsonSchema: {},
      fetchImpl,
    });

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://explicit-host:11434/api/chat");
    const body = lastRequestBody(fetchImpl);
    expect(body.model).toBe("explicit-model");
  });

  describe("timeout handling", () => {
    /** Mimics real fetch's AbortSignal contract: never resolves on its own,
     * only rejects once the signal it was given aborts — matching how a
     * genuinely wedged Ollama would behave under a real AbortController. */
    function makeHangingFetch() {
      return vi.fn<typeof fetch>((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
    }

    it("aborts and returns ok:false with a timeout reason when the call exceeds timeoutMs (not a throw, not a hang)", async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeHangingFetch();
        const resultPromise = callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl, timeoutMs: 5000 });

        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the abort timer on the success path (no dangling handle)", async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = makeFetch({ message: { content: "{}" } });
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
        // If the timer were never cleared, it would still be pending here —
        // fake timers never auto-fire without an explicit advance.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("honours a custom timeoutMs when arming the abort timer", async () => {
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl, timeoutMs: 5000 });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("defaults the abort timer to 120000ms when neither timeoutMs nor OLLAMA_TIMEOUT_MS is set", async () => {
      delete process.env.OLLAMA_TIMEOUT_MS;
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("resolves the abort timer from OLLAMA_TIMEOUT_MS when set and no explicit timeoutMs is passed", async () => {
      process.env.OLLAMA_TIMEOUT_MS = "9000";
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 9000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("falls back to the 120000ms default when OLLAMA_TIMEOUT_MS is set but not a valid positive number", async () => {
      process.env.OLLAMA_TIMEOUT_MS = "not-a-number";
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("falls back to the 120000ms default when OLLAMA_TIMEOUT_MS is zero or negative", async () => {
      process.env.OLLAMA_TIMEOUT_MS = "0";
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("prefers an explicit opts.timeoutMs over OLLAMA_TIMEOUT_MS", async () => {
      process.env.OLLAMA_TIMEOUT_MS = "9000";
      const fetchImpl = makeFetch({ message: { content: "{}" } });
      const setTimeoutSpy = vi.spyOn(global, "setTimeout");
      try {
        await callOllama({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, fetchImpl, timeoutMs: 3000 });
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });
});
