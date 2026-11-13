import { describe, it, expect, vi } from "vitest";

import { MAX_BYTES, RefusedError, main, runFetch, vetUrl } from "./fetch-url";
import type { ResolveDeps } from "./net-guard";

const PUBLIC = async () => ["93.184.216.34"];
const NONE = async () => [] as string[];
const deps: ResolveDeps = { resolve4: PUBLIC, resolve6: NONE };

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body || null, { status, headers });
}

async function collect(url: string, fetchImpl: typeof fetch, d = deps): Promise<string> {
  const chunks: Uint8Array[] = [];
  await runFetch(url, { ...d, fetchImpl, write: (c) => void chunks.push(c) });
  return Buffer.concat(chunks).toString();
}

describe("vetUrl", () => {
  it.each([
    "http://127.0.0.1:11434/",
    "http://[::1]/",
    "http://169.254.169.254/latest/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://localhost/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/",
    "http://１２７.0.0.1/",
    "http://127%2E0.0.1/",
    "http://example.com@127.0.0.1/",
    "ftp://example.com/",
    "file:///etc/passwd",
  ])("refuses %s", async (u) => {
    await expect(vetUrl(u, deps)).rejects.toBeInstanceOf(RefusedError);
  });

  it("refuses a public name that resolves to loopback", async () => {
    await expect(vetUrl("http://evil.example/", { resolve4: async () => ["127.0.0.1"], resolve6: NONE })).rejects.toThrow(/blocked address/);
  });

  it("refuses when any one resolved address is private", async () => {
    await expect(vetUrl("http://mixed.example/", { resolve4: async () => ["93.184.216.34", "10.1.1.1"], resolve6: NONE })).rejects.toBeInstanceOf(RefusedError);
  });

  it("accepts a public host and an @ in the path", async () => {
    await expect(vetUrl("https://medium.com/@someone/post", deps)).resolves.toBeInstanceOf(URL);
  });
});

describe("runFetch", () => {
  it("streams the body of a public URL", async () => {
    const f = vi.fn(async () => res(200, "hello"));
    expect(await collect("https://example.com/", f as never)).toBe("hello");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect", async () => {
    const f = vi.fn(async (u: string) => (u === "https://example.com/a" ? res(302, "", { location: "/b" }) : res(200, "b-body")));
    expect(await collect("https://example.com/a", f as never)).toBe("b-body");
  });

  it("refuses a public URL that redirects to loopback, never connecting to it", async () => {
    const f = vi.fn(async () => res(302, "", { location: "http://127.0.0.1:11434/api/tags" }));
    await expect(collect("https://example.com/", f as never)).rejects.toBeInstanceOf(RefusedError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refuses redirects to metadata, protocol-relative, backslash and percent-encoded targets", async () => {
    for (const location of ["http://169.254.169.254/", "//127.0.0.1/", "/\\127.0.0.1/", "http://127%2E0.0.1/", "http://%EF%BC%91.0.0.1/", "file:///etc/passwd"]) {
      const f = vi.fn(async () => res(301, "", { location }));
      await expect(collect("https://example.com/", f as never)).rejects.toBeInstanceOf(RefusedError);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a redirect to a name that resolves privately", async () => {
    const f = vi.fn(async () => res(302, "", { location: "http://rebind.example/" }));
    const d = { resolve4: async (h: string) => (h === "rebind.example" ? ["192.168.0.5"] : ["93.184.216.34"]), resolve6: NONE };
    await expect(collect("https://example.com/", f as never, d)).rejects.toBeInstanceOf(RefusedError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("stops after 10 redirects", async () => {
    const f = vi.fn(async () => res(302, "", { location: "/again" }));
    await expect(collect("https://example.com/", f as never)).rejects.toThrow(/too many redirects/);
    expect(f).toHaveBeenCalledTimes(11);
  });

  it("does not call fetch when the first URL is refused", async () => {
    const f = vi.fn();
    await expect(collect("http://127.0.0.1/", f as never)).rejects.toBeInstanceOf(RefusedError);
    expect(f).not.toHaveBeenCalled();
  });
});

function bigBody(n: number): Response {
  const chunk = new Uint8Array(1 << 20).fill(97);
  let left = n;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (left <= 0) return c.close();
      const k = Math.min(left, chunk.length);
      c.enqueue(chunk.subarray(0, k));
      left -= k;
    },
  });
  return new Response(body, { status: 200 });
}

describe("size cap", () => {
  const count = async (n: number) => {
    let written = 0;
    const p = runFetch("https://example.com/", { ...deps, fetchImpl: (async () => bigBody(n)) as never, write: (c) => void (written += c.byteLength) });
    return { p, written: () => written };
  };

  it("passes a body of exactly MAX_BYTES", async () => {
    const r = await count(MAX_BYTES);
    await expect(r.p).resolves.toBeUndefined();
    expect(r.written()).toBe(MAX_BYTES);
  });

  it("writes MAX_BYTES then fails on MAX_BYTES + 1", async () => {
    const r = await count(MAX_BYTES + 1);
    await expect(r.p).rejects.toThrow(/size limit/);
    expect(r.written()).toBe(MAX_BYTES);
  });
});

describe("timeout", () => {
  it("aborts a hung fetch and main maps it to exit 1", async () => {
    const hung = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as never;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["https://example.com/"], { ...deps, fetchImpl: hung, timeoutMs: 20, write: () => {} })).toBe(1);
    err.mockRestore();
  });
});

describe("main exit codes", () => {
  const run = async (url: string, fetchImpl: unknown) => {
    const out: Uint8Array[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main([url], { ...deps, fetchImpl: fetchImpl as never, write: (c) => void out.push(c) });
    err.mockRestore();
    return { code, out: Buffer.concat(out).toString() };
  };

  it("success writes the exact bytes and exits 0", async () => {
    expect(await run("https://example.com/", async () => res(200, "exact-bytes\n"))).toEqual({ code: 0, out: "exact-bytes\n" });
  });

  it.each([404, 500])("HTTP %i with a body prints it and exits 0", async (status) => {
    expect(await run("https://example.com/", async () => res(status, "err page"))).toEqual({ code: 0, out: "err page" });
  });

  it("network error exits 1", async () => {
    expect((await run("https://example.com/", async () => Promise.reject(new TypeError("fetch failed")))).code).toBe(1);
  });

  it("refusal exits 2 and never fetches", async () => {
    const f = vi.fn();
    expect((await run("http://127.0.0.1/", f)).code).toBe(2);
    expect(f).not.toHaveBeenCalled();
  });

  it("wrong argument count exits 2", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main([])).toBe(2);
    err.mockRestore();
  });
});
