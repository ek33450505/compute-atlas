// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetch-pages.mjs is an operator-run script over contributor-reachable URLs. It
// must fetch through the guarded fetcher (pinned transport, per-hop SSRF
// re-validation, manual redirects), never the global fetch.
const { pinnedFetchMock } = vi.hoisted(() => ({ pinnedFetchMock: vi.fn() }));

vi.mock("../net-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../net-guard")>()),
  pinnedFetch: pinnedFetchMock,
}));

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

import { fetchOne, fetchOptions, duplicateIds, readExistingPages, refreshDrops, selectTargets } from "./fetch-pages.mjs";

const target = (sources: string[]) => ({
  id: "t1", name: "Acme Campus", city: "Reno", state: "NV",
  facilityType: "data_center", status: "operational", truth: {}, sources,
});
const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });

let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  pinnedFetchMock.mockReset();
  globalFetch = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", globalFetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetch-pages fetchOne", () => {
  it("caches an HTML page fetched through the pinned transport", async () => {
    pinnedFetchMock.mockResolvedValue(html("capacity ".repeat(100)));
    const entry = await fetchOne(target(["https://example.com/a"]));
    expect(entry?.url).toBe("https://example.com/a");
    expect(entry?.text).toContain("capacity");
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("skips a private IP literal as blocked without any fetch", async () => {
    const entry = await fetchOne(target(["http://127.0.0.1/x"]));
    expect(entry).toBeNull();
    expect(pinnedFetchMock).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("blocked"));
  });

  it("follows a 302 with a second guarded call", async () => {
    pinnedFetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://example.com/b" } }))
      .mockResolvedValueOnce(html("capacity ".repeat(100)));
    const entry = await fetchOne(target(["https://example.com/a"]));
    expect(entry).not.toBeNull();
    expect(pinnedFetchMock).toHaveBeenCalledTimes(2);
    expect(String(pinnedFetchMock.mock.calls[1][0])).toContain("example.com/b");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("skips PDF content-type and .pdf URLs", async () => {
    pinnedFetchMock.mockResolvedValue(new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }));
    expect(await fetchOne(target(["https://example.com/a", "https://example.com/b.pdf"]))).toBeNull();
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a 3 MB HTML body (above the guarded fetcher's 2 MB default)", async () => {
    pinnedFetchMock.mockResolvedValue(html("capacity ".repeat(350_000)));
    const entry = await fetchOne(target(["https://example.com/big"]));
    expect(entry?.rawLength).toBeGreaterThan(3 * 1024 * 1024);
  });

  const CAP = 32 * 1024 * 1024;
  const bytesOf = (n: number) =>
    new Response(new Uint8Array(n).fill(120), { status: 200, headers: { "content-type": "text/html" } });
  const warned = () => vi.mocked(console.log).mock.calls.filter(([m]) => String(m).includes("will DROP it"));

  it("accepts a body of exactly 32 MB and rejects 32 MB + 1 byte as too_large", async () => {
    pinnedFetchMock.mockImplementationOnce(async () => bytesOf(CAP));
    expect(await fetchOne(target(["https://example.com/cap"]))).not.toBeNull();
    pinnedFetchMock.mockImplementationOnce(async () => bytesOf(CAP + 1));
    expect(await fetchOne(target(["https://example.com/over"]))).toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("too_large skip  t1"));
    expect(warned()).toHaveLength(0);
  });

  it("--refresh: all sources too_large on a cached id warns exactly once", async () => {
    pinnedFetchMock.mockImplementation(async () => bytesOf(CAP + 1));
    const opts = fetchOptions([{ facilityId: "t1" }], { refresh: true });
    expect(await fetchOne(target(["https://example.com/a", "https://example.com/b"]), opts)).toBeNull();
    expect(warned()).toHaveLength(1);
    expect(String(warned()[0][0])).toContain("t1");
  });

  it("--refresh: [too_large, ok] saves the entry with no warning", async () => {
    pinnedFetchMock
      .mockImplementationOnce(async () => bytesOf(CAP + 1))
      .mockResolvedValueOnce(html("capacity ".repeat(100)));
    const opts = fetchOptions([{ facilityId: "t1" }], { refresh: true });
    expect(await fetchOne(target(["https://example.com/a", "https://example.com/b"]), opts)).not.toBeNull();
    expect(warned()).toHaveLength(0);
  });

  it("without --refresh a too_large skip of a cached id does not warn (options carry no droppable ids)", async () => {
    pinnedFetchMock.mockImplementation(async () => bytesOf(CAP + 1));
    const opts = fetchOptions([{ facilityId: "t1" }], { refresh: false });
    expect(await fetchOne(target(["https://example.com/a"]), opts)).toBeNull();
    expect(warned()).toHaveLength(0);
  });

  it("--refresh: a cached id whose only source 404s warns once, naming http_error 404", async () => {
    pinnedFetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const opts = fetchOptions([{ facilityId: "t1" }], { refresh: true });
    expect(await fetchOne(target(["https://example.com/gone"]), opts)).toBeNull();
    const w = warned();
    expect(w).toHaveLength(1);
    expect(String(w[0][0])).toContain("t1");
    expect(String(w[0][0])).toContain("http_error 404");
    expect(String(w[0][0])).not.toContain("MAX_BENCH_BYTES");
  });

  it("accepts application/xhtml+xml and rejects a missing content-type", async () => {
    pinnedFetchMock.mockResolvedValueOnce(
      new Response(`<html><body>${"capacity ".repeat(100)}</body></html>`, { status: 200, headers: { "content-type": "application/xhtml+xml; charset=utf-8" } }),
    );
    expect(await fetchOne(target(["https://example.com/x"]))).not.toBeNull();
    // A bytes body gets no automatic content-type (a string body gets text/plain).
    pinnedFetchMock.mockResolvedValueOnce(new Response(new TextEncoder().encode(`<html><body>${"capacity ".repeat(100)}</body></html>`), { status: 200 }));
    expect(await fetchOne(target(["https://example.com/y"]))).toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("bad_content_type skip"));
  });

  it("fetchOptions: only --refresh marks cached ids as droppable", () => {
    const pages = [{ facilityId: "a" }, { facilityId: "b" }];
    expect([...fetchOptions(pages, { refresh: true }).droppableIds]).toEqual(["a", "b"]);
    expect(fetchOptions(pages, { refresh: false }).droppableIds.size).toBe(0);
    expect(fetchOptions(pages).droppableIds.size).toBe(0);
  });

  it("selectTargets: additive fetches only uncached, --refresh all, --only the named ids", () => {
    const targets = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const cached = [{ facilityId: "a" }];
    expect(selectTargets(targets, cached).map((t) => t.id)).toEqual(["b", "c"]);
    expect(selectTargets(targets, cached, { refresh: true }).map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(selectTargets(targets, cached, { only: new Set(["a", "c"]) }).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("selectTargets: --refresh wins over --only; an --only id absent from targets selects nothing", () => {
    const targets = [{ id: "a" }, { id: "b" }];
    expect(selectTargets(targets, [], { refresh: true, only: new Set(["a"]) }).map((t) => t.id)).toEqual(["a", "b"]);
    expect(selectTargets(targets, [], { only: new Set(["zzz"]) })).toEqual([]);
  });

  it("refreshDrops returns the expected removed/failed/all, and each failed id gets exactly one fetchOne warning (duplicate target id included)", async () => {
    const targets = [
      { ...target(["https://example.com/gone"]), id: "failing" },
      { ...target(["https://example.com/gone"]), id: "failing" }, // duplicate id
      { ...target(["https://example.com/ok"]), id: "fine" },
    ];
    const cached = [{ facilityId: "failing" }, { facilityId: "fine" }, { facilityId: "retired" }];
    pinnedFetchMock.mockImplementation(async (u: unknown) =>
      String(u).endsWith("/ok") ? html("capacity ".repeat(100)) : new Response("nope", { status: 404 }));
    const opts = fetchOptions(cached, { refresh: true });
    const fetched = [];
    for (const t of selectTargets(targets, cached, { refresh: true })) {
      const e = await fetchOne(t, opts);
      if (e) fetched.push(e);
    }
    const drops = refreshDrops(cached, targets, fetched);
    expect(drops).toEqual({ removed: ["retired"], failed: ["failing"], all: ["failing", "retired"] });
    // fetchOne warns for `failed` ids; main prints one line per `removed` id.
    const warnedIds = warned().map(([m]) => String(m).trim().split(" ")[1]);
    expect(warnedIds).toEqual(drops.failed);
  });

  it("refreshDrops: a present, fetched id is not reported", () => {
    expect(refreshDrops([{ facilityId: "a" }], [{ id: "a" }], [{ facilityId: "a" }]).all).toEqual([]);
  });

  it("readExistingPages: missing file is [], corrupt JSON, non-array JSON and unreadable paths throw naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-"));
    try {
      expect(readExistingPages(join(dir, "nope.json"))).toEqual([]);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{not json");
      expect(() => readExistingPages(bad)).toThrow(bad);
      const obj = join(dir, "obj.json");
      writeFileSync(obj, "{}");
      expect(() => readExistingPages(obj)).toThrow(obj);
      expect(() => readExistingPages(dir)).toThrow(dir); // EISDIR, not ENOENT
      const good = join(dir, "good.json");
      writeFileSync(good, '[{"facilityId":"a"}]');
      expect(readExistingPages(good)).toEqual([{ facilityId: "a" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selectTargets dedupes by id in additive and --only modes too; duplicateIds reports each once", () => {
    const targets = [{ id: "a", n: 1 }, { id: "a", n: 2 }, { id: "b", n: 3 }, { id: "a", n: 4 }];
    expect(selectTargets(targets, []).map((t) => t.n)).toEqual([1, 3]);
    expect(selectTargets(targets, [], { only: new Set(["a"]) }).map((t) => t.n)).toEqual([1]);
    expect(selectTargets(targets, [{ facilityId: "b" }]).map((t) => t.n)).toEqual([1]);
    expect(duplicateIds(targets)).toEqual(["a"]);
    expect(duplicateIds([{ id: "a" }, { id: "b" }])).toEqual([]);
  });

  it("logs thin pages as `thin_page skip  <id>`", async () => {
    pinnedFetchMock.mockResolvedValue(html("short"));
    expect(await fetchOne(target(["https://example.com/thin"]))).toBeNull();
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^ {2}thin_page skip {2}t1 \(\d+ch\)$/));
  });
});
