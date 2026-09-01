import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchJSON } from "./build-map-data.mjs";

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  }));
}

describe("fetchJSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects on an ArcGIS error body returned with HTTP 200", async () => {
    // ArcGIS reports failures in the response BODY, not the status line — a
    // 200 with {"error":{...}} used to parse as a successful empty result.
    vi.stubGlobal(
      "fetch",
      mockFetchOnce({
        error: { code: 400, message: "Unable to complete operation." },
      }),
    );
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).rejects.toThrow(
      /400.*Unable to complete operation\./,
    );
  });

  it("resolves with the body on an ordinary successful response (no false positive)", async () => {
    const body = { features: [{ id: 1 }] };
    vi.stubGlobal("fetch", mockFetchOnce(body));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).resolves.toEqual(body);
  });

  it("does not throw when `error` is falsy or absent", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: null, features: [] }));
    await expect(
      fetchJSON("https://example.com/query", { retries: 0 }),
    ).resolves.toEqual({ error: null, features: [] });

    vi.stubGlobal("fetch", mockFetchOnce({ features: [] }));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).resolves.toEqual({
      features: [],
    });
  });

  it("still rejects on a non-200 HTTP status (no regression)", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({}, 500));
    await expect(fetchJSON("https://example.com/query", { retries: 0 })).rejects.toThrow(/500/);
  });
});
