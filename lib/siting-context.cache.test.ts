import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake unstable_cache that records its arguments and, like the real one,
// stores only RESOLVED results: a callback that rejects is never stored.
const cacheState = vi.hoisted(() => ({
  registered: [] as { keyParts: string[]; options: { tags?: string[]; revalidate?: number } }[],
  store: new Map<string, unknown>(),
  rejections: [] as unknown[],
}));

vi.mock("next/cache", () => ({
  unstable_cache: (cb: () => Promise<unknown>, keyParts: string[], options: { tags?: string[]; revalidate?: number }) => {
    cacheState.registered.push({ keyParts, options });
    const key = keyParts.join("|");
    return async () => {
      if (cacheState.store.has(key)) return cacheState.store.get(key);
      try {
        const value = await cb();
        cacheState.store.set(key, value);
        return value;
      } catch (err) {
        cacheState.rejections.push(err);
        throw err;
      }
    };
  },
}));

import sitingContextRaw from "@/data/siting-context.json";
import {
  getSitingContext,
  getWaterStressById,
  neonSitingSource,
  type SitingContext,
} from "./siting-context";

const snapshot = sitingContextRaw as Record<string, SitingContext>;
const ID = "xai-colossus-memphis-tn";
const NEON: SitingContext = { waterStress: { cat: 4, label: "From Neon (>80%)" } };

describe("siting-context cache layer (real getters, VITEST bypass off)", () => {
  beforeEach(() => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cacheState.store.clear();
    cacheState.rejections.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("(a) tags and revalidate: per-facility `facility:<id>`, water-stress `facilities`", async () => {
    vi.spyOn(neonSitingSource, "one").mockResolvedValue(NEON);
    await getSitingContext(ID);
    const perFacility = cacheState.registered.find((r) => r.keyParts.join("|") === `siting-context|${ID}`);
    expect(perFacility?.options).toEqual({ tags: [`facility:${ID}`], revalidate: 86400 });

    const table = cacheState.registered.find((r) => r.keyParts.join("|") === "siting-context|water-stress");
    expect(table?.options).toEqual({ tags: ["facilities"], revalidate: 86400 });
  });

  it("(b) a Neon throw is not stored: it falls back outside the cache, and the next read sees Neon again", async () => {
    const one = vi
      .spyOn(neonSitingSource, "one")
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "08006" }))
      .mockResolvedValue(NEON);

    expect(await getSitingContext(ID)).toEqual(snapshot[ID]);
    expect(cacheState.rejections).toHaveLength(1);
    expect(cacheState.store.size).toBe(0);

    expect(await getSitingContext(ID)).toEqual(NEON);
    expect(one).toHaveBeenCalledTimes(2);
  });

  it("(b) a missing row IS a cacheable 'no data' result, not a throw", async () => {
    vi.spyOn(neonSitingSource, "one").mockResolvedValue(undefined);
    expect(await getSitingContext(ID)).toBeUndefined();
    expect(cacheState.rejections).toHaveLength(0);
    expect(cacheState.store.get(`siting-context|${ID}`)).toBeNull();
  });

  it("(b) water-stress: a throw, an empty table and an invalid entry all fall back and are not stored", async () => {
    const expected = Object.fromEntries(
      Object.entries(snapshot).filter(([, v]) => v.waterStress).map(([id, v]) => [id, v.waterStress])
    );
    const ws = vi.spyOn(neonSitingSource, "waterStress");

    ws.mockRejectedValueOnce(new Error("boom"));
    expect(await getWaterStressById()).toEqual(expected);

    ws.mockResolvedValueOnce(new Map());
    expect(await getWaterStressById()).toEqual(expected);

    ws.mockResolvedValueOnce(new Map<string, unknown>([[ID, { cat: "high" }]]));
    expect(await getWaterStressById()).toEqual(expected);

    expect(cacheState.rejections).toHaveLength(3);
    expect(cacheState.store.size).toBe(0);

    ws.mockResolvedValueOnce(new Map([[ID, NEON.waterStress]]));
    expect(await getWaterStressById()).toEqual({ [ID]: NEON.waterStress });
  });
});
