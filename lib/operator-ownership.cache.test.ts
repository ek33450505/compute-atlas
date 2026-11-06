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

import { tagsForFacility } from "./cache-tags";
import { operatorSlug } from "./operator-slug";
import type { Facility } from "./schema";
import {
  getAllOperatorOwnership,
  getOperatorOwnership,
  neonOwnershipSource,
  operatorOwnership,
  parseOperatorOwnership,
} from "./operator-ownership";

const OPERATOR = "QTS Data Centers";
const NEON = parseOperatorOwnership([
  {
    operator: OPERATOR,
    owners: [
      {
        name: "Neon Owner",
        kind: "organization",
        role: "controlling_owner",
        source: { url: "https://example.com/x", label: "X", retrievedAt: "2026-11-04", kind: "filing" },
        asOf: "2026-11-04",
      },
    ],
  },
]);

describe("operator-ownership cache layer (real getters, VITEST bypass off)", () => {
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

  it("(a) tags and revalidate: per-operator tag equals what cache-tags builds, whole table `facilities`", async () => {
    vi.spyOn(neonOwnershipSource, "one").mockResolvedValue(NEON[0]);
    vi.spyOn(neonOwnershipSource, "all").mockResolvedValue(NEON);
    await getOperatorOwnership(OPERATOR);
    await getAllOperatorOwnership();

    // The tag a facility write busts for this operator, as lib/cache-tags.ts builds it.
    const busted = tagsForFacility({
      id: "x",
      operator: OPERATOR,
      location: { state: "VA" },
      facilityType: "data_center",
    } as unknown as Facility).find((t) => t.startsWith("operator:"));
    expect(busted).toBe(`operator:${operatorSlug(OPERATOR)}`);

    const one = cacheState.registered.find((r) => r.keyParts.join("|") === `operator-ownership|${OPERATOR}`);
    expect(one?.options).toEqual({ tags: [busted], revalidate: 86400 });

    const all = cacheState.registered.find((r) => r.keyParts.join("|") === "operator-ownership|all");
    expect(all?.options).toEqual({ tags: ["facilities"], revalidate: 86400 });
  });

  it("(b) a Neon throw is not stored: it falls back outside the cache, and the next read sees Neon again", async () => {
    const one = vi
      .spyOn(neonOwnershipSource, "one")
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "08006" }))
      .mockResolvedValue(NEON[0]);

    expect(await getOperatorOwnership(OPERATOR)).toEqual(operatorOwnership.filter((o) => o.operator === OPERATOR));
    expect(cacheState.rejections).toHaveLength(1);
    expect(cacheState.store.size).toBe(0);

    expect(await getOperatorOwnership(OPERATOR)).toEqual(NEON);
    expect(one).toHaveBeenCalledTimes(2);
  });

  it("(b) an invalid row is not stored either", async () => {
    vi.spyOn(neonOwnershipSource, "one").mockResolvedValue({ operator: OPERATOR, owners: [] });
    await getOperatorOwnership(OPERATOR);
    expect(cacheState.rejections).toHaveLength(1);
    expect(cacheState.store.size).toBe(0);
  });

  it("(b) a missing row IS a cacheable 'no owners' result, not a throw", async () => {
    vi.spyOn(neonOwnershipSource, "one").mockResolvedValue(undefined);
    expect(await getOperatorOwnership(OPERATOR)).toEqual([]);
    expect(cacheState.rejections).toHaveLength(0);
    expect(cacheState.store.get(`operator-ownership|${OPERATOR}`)).toEqual([]);
  });

  it("(b) whole table: a throw and an empty table fall back and are not stored", async () => {
    const all = vi.spyOn(neonOwnershipSource, "all");
    all.mockRejectedValueOnce(new Error("boom"));
    expect(await getAllOperatorOwnership()).toBe(operatorOwnership);
    all.mockResolvedValueOnce([]);
    expect(await getAllOperatorOwnership()).toBe(operatorOwnership);
    expect(cacheState.rejections).toHaveLength(2);
    expect(cacheState.store.size).toBe(0);

    all.mockResolvedValueOnce(NEON);
    expect(await getAllOperatorOwnership()).toEqual(NEON);
  });
});
