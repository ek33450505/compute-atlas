import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchJSON, propGNISName } from "./build-map-data.mjs";

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

describe("propGNISName", () => {
  it("applies the editorial override for a renamed upstream waterbody", () => {
    expect(propGNISName({ GNIS_NAME: "Lake America" })).toBe("Lake Ontario");
  });

  it("trims before matching the override", () => {
    expect(propGNISName({ GNIS_NAME: "  Lake America  " })).toBe("Lake Ontario");
  });

  it("matches the override case-insensitively", () => {
    expect(propGNISName({ GNIS_NAME: "LAKE AMERICA" })).toBe("Lake Ontario");
  });

  it("passes a non-overridden name through untouched", () => {
    // Important: a broken override map that mangled every name would
    // otherwise still pass the two tests above.
    expect(propGNISName({ GNIS_NAME: "Lake Erie" })).toBe("Lake Erie");
  });

  it("applies the override via the lowercase-property fallback (NHD layers vary in casing)", () => {
    expect(propGNISName({ gnis_name: "Lake America" })).toBe("Lake Ontario");
  });

  it("still returns null for empty or missing names (override does not resurrect them)", () => {
    expect(propGNISName({ GNIS_NAME: "   " })).toBeNull();
    expect(propGNISName({})).toBeNull();
  });
});
