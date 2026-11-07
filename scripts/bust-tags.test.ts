// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { bustAfterUpserts, bustAfterWrite, bustErrorSummary, bustTags, resolveRevalidate } from "./bust-tags";

const TOKEN = "sekret";

function resolve(baseUrl: string | undefined, over: { apply?: boolean; skipRevalidate?: boolean } = {}) {
  return resolveRevalidate({
    apply: true,
    skipRevalidate: false,
    ...over,
    env: { API_BASE_URL: baseUrl, API_ADMIN_TOKEN: TOKEN },
  });
}

describe("resolveRevalidate", () => {
  it("accepts https and loopback http", () => {
    expect(resolve("https://www.example.com")).toEqual({ baseUrl: "https://www.example.com", token: TOKEN });
    expect(resolve("http://localhost:3000")).not.toBeNull();
    expect(resolve("http://127.0.0.1:3000")).not.toBeNull();
  });

  it("refuses plain http to a non-loopback host, naming scheme and host but not the token", () => {
    expect(() => resolve("http://www.example.com")).toThrow(/http:\/\/www\.example\.com/);
    try {
      resolve("http://www.example.com");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it("refuses a lookalike loopback host, a garbage URL and other schemes", () => {
    expect(() => resolve("http://localhost.evil.com")).toThrow(/uses http:\/\/localhost\.evil\.com; the admin token is only sent over https/);
    expect(() => resolve("not a url")).toThrow(/not a valid URL/);
    expect(() => resolve("ftp://example.com")).toThrow(/uses ftp:\/\/example\.com; the admin token is only sent over https/);
  });

  it("refuses missing env with (set)/(unset) detail, and returns null for dry run or skip", () => {
    expect(() => resolve(undefined)).toThrow(/API_BASE_URL: \(unset\)[\s\S]*API_ADMIN_TOKEN: \(set\)/);
    expect(resolve("http://evil.test", { apply: false })).toBeNull();
    expect(resolve("http://evil.test", { skipRevalidate: true })).toBeNull();
  });
});

describe("bustTags", () => {
  it("throws on an invalid tag without fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(bustTags(["facilities", "Bad Tag"], { baseUrl: "https://x.test", token: "t", fetchImpl })).rejects.toThrow(/allowlist/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("bustTags error recording", () => {
  const opts = { baseUrl: "https://x.test", token: "t" };

  it("never follows a redirect with the admin bearer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await bustTags(["facilities"], { ...opts, fetchImpl });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("stores a fixed network error string, never the raw fetch message", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED https://x.test/api/revalidate"));
    const r = await bustTags(["facilities"], { ...opts, fetchImpl });
    expect(r.errors).toEqual(["network error"]);
  });

  it("cancels the body of a non-ok response without reading it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, body: { cancel }, text });
    const r = await bustTags(["facilities"], { ...opts, fetchImpl });
    expect(r.errors).toEqual(["HTTP 503 [facilities]"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("survives a failing cancel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, body: { cancel: () => Promise.reject(new Error("x")) } });
    const r = await bustTags(["facilities"], { ...opts, fetchImpl });
    expect(r.failedTags).toEqual(["facilities"]);
  });
});

describe("bustErrorSummary", () => {
  it("keeps status codes and drops bodies and fetch messages", () => {
    expect(bustErrorSummary(["HTTP 503 leak sekret", "HTTP 503 again", "connect ECONNREFUSED https://x.test"])).toBe("503, network error");
  });
});

describe("bustAfterUpserts", () => {
  const ok = () => vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const config = { baseUrl: "https://x.test", token: "t" };

  it("still busts the written rows when the op throws after the write, then rethrows the original error", async () => {
    const f = ok();
    const log = vi.fn();
    await expect(
      bustAfterUpserts(
        { store: fakeStore(), tagsFor: (k) => [...k.map((x) => `facility:${x}`), "facilities"], config, deps: { log, fetchImpl: f } },
        async (st) => {
          await st.upsert([{ key: "a", data: {} }]);
          throw new Error("read-back differs");
        },
      ),
    ).rejects.toThrow("read-back differs");
    expect(JSON.parse(f.mock.calls[0][1].body).tags).toEqual(["facility:a", "facilities"]);
  });

  it("a read-back throw plus a bust failure rethrows the original, logs status and failed tags, never the body", async () => {
    const f = vi.fn().mockResolvedValue(new Response("echo sekret", { status: 503 }));
    const log = vi.fn();
    await expect(
      bustAfterUpserts(
        { store: fakeStore(), tagsFor: (k) => [...k.map((x) => `facility:${x}`), "facilities"], config, deps: { log, fetchImpl: f } },
        async (st) => {
          await st.upsert([{ key: "a", data: {} }]);
          throw new Error("read-back differs");
        },
      ),
    ).rejects.toThrow("read-back differs");
    const lines = log.mock.calls.map((c) => c[0] as string).join("\n");
    expect(lines).toContain("(503): facility:a, facilities");
    expect(lines).not.toContain("sekret");
  });

  it("names at most 20 failed tags then (+N more); 20 or fewer print in full with no suffix", async () => {
    const failing = () => vi.fn().mockImplementation(async () => new Response("", { status: 503 }));
    const msg = async (n: number) => {
      const tags = Array.from({ length: n }, (_, i) => `facility:t${i}`);
      try {
        await bustAfterWrite(tags, config, { log: vi.fn(), fetchImpl: failing() });
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a throw");
    };
    const over = await msg(25);
    expect(over).toContain("facility:t19");
    expect(over).not.toContain("facility:t20");
    expect(over).toContain("(+5 more)");
    const exact = await msg(20);
    expect(exact).toContain("facility:t19");
    expect(exact).not.toContain("more)");
  });

  it("reports keys in flight when upsert itself throws", async () => {
    const f = ok();
    const store = { readAll: async () => [], upsert: async () => { throw new Error("db down"); } } as unknown as ReturnType<typeof fakeStore>;
    await expect(
      bustAfterUpserts({ store, tagsFor: (k) => k.map((x) => `facility:${x}`), config, deps: { log: vi.fn(), fetchImpl: f } }, async (st) => {
        await st.upsert([{ key: "a", data: {} }]);
      }),
    ).rejects.toThrow("db down");
    expect(JSON.parse(f.mock.calls[0][1].body).tags).toEqual(["facility:a"]);
  });

  it("does not bust when nothing was upserted", async () => {
    const f = ok();
    await expect(
      bustAfterUpserts({ store: fakeStore(), tagsFor: () => ["facilities"], config, deps: { log: vi.fn(), fetchImpl: f } }, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(f).not.toHaveBeenCalled();
  });
});
