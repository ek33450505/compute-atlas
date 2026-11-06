// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fakeStore } from "./fake-keyed-store";
import { bustAfterUpserts, bustErrorSummary, bustTags, resolveRevalidate } from "./bust-tags";

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
    expect(() => resolve("http://localhost.evil.com")).toThrow(/https/);
    expect(() => resolve("not a url")).toThrow(/not a valid URL/);
    expect(() => resolve("ftp://example.com")).toThrow(/https/);
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
