import { describe, expect, it } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import {
  FACILITY_CACHE_SHARDS,
  createFacilityMergeMemo,
  createPowerGenerationDecodeMemo,
  decodePowerGeneration,
  encodeFacilityShard,
  encodePowerGeneration,
  facilityShard,
  mergeFacilityShards,
} from "@/lib/data";
import type { Facility, PowerGenerationFacility } from "@/lib/schema";

// Next refuses to store a data-cache entry over 2 MiB (2,097,152 bytes), envelope
// included, and the failure is a console.warn, not an error — see the comment
// above FACILITY_CACHE_SHARDS in lib/data.ts. 472cb36 (2026-10-13) crossed it with
// a single blob and the production build ran out of heap. Fail at HALF the
// limit so a data wave warns while there is still room to add shards.
const SHARD_BUDGET_BYTES = 1024 * 1024;

const facilities = facilitiesRaw as { id: string }[];

describe("facility data-cache shards", () => {
  it("puts every facility in exactly one shard, and uses every shard", () => {
    const counts = new Array<number>(FACILITY_CACHE_SHARDS).fill(0);
    for (const f of facilities) {
      const shard = facilityShard(f.id);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(FACILITY_CACHE_SHARDS);
      counts[shard]++;
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(facilities.length);
    expect(counts.every((n) => n > 0)).toBe(true);
  });

  it("keeps each shard's gzip+base64 payload under half the 2 MiB entry limit", () => {
    for (let shard = 0; shard < FACILITY_CACHE_SHARDS; shard++) {
      const blob = encodeFacilityShard(facilities as unknown as Facility[], shard);
      expect(blob.length, `shard ${shard}`).toBeLessThan(SHARD_BUDGET_BYTES);
    }
  });

  it("round-trips: split into shard blobs, merge back == the sorted full list, nothing dropped or duplicated", () => {
    const all = facilitiesRaw as unknown as Facility[];
    const expected = [...all].sort((a, b) => a.id.localeCompare(b.id));
    const blobs = Array.from({ length: FACILITY_CACHE_SHARDS }, (_, s) =>
      encodeFacilityShard(all, s)
    );
    const merged = mergeFacilityShards(blobs);
    expect(merged.map((f) => f.id)).toEqual(expected.map((f) => f.id));
    expect(merged).toEqual(expected);
  });

  it("keeps the gzip+base64 power_generation cache entry under half the 2 MiB entry limit", () => {
    // `loadPowerGenerationCached` stores this list as gzip+base64 in `unstable_cache`.
    // History: plain JSON was ~870KB (42% of 2 MiB) on 2026-10-13, warn at 50% while
    // there is room to gzip it. 2026-10-28: 1,051,986 plain chars (UTF-16 units, not bytes) tripped the 50%
    // guard; now gzip+base64. Measures facilities.json as a proxy for the DB-derived
    // docs the cache stores.
    const power = (facilitiesRaw as unknown as Facility[]).filter(
      (f): f is PowerGenerationFacility => f.facilityType === "power_generation"
    );
    const blob = encodePowerGeneration(power);
    expect(blob.length).toBeLessThan(SHARD_BUDGET_BYTES);
    expect(decodePowerGeneration(blob)).toEqual(power);
    const decode = createPowerGenerationDecodeMemo();
    const first = decode(blob);
    expect(decode((" " + blob).slice(1))).toBe(first);
    const miss = decode(encodePowerGeneration([]));
    expect(miss).not.toBe(first);
    expect(miss).toEqual([]);
  });
});

describe("createFacilityMergeMemo", () => {
  const all = facilitiesRaw as unknown as Facility[];
  const encode = (list: Facility[]) =>
    Array.from({ length: FACILITY_CACHE_SHARDS }, (_, s) => encodeFacilityShard(list, s));

  it("reuses the parse while the blobs are unchanged, even as fresh string copies", () => {
    const merge = createFacilityMergeMemo();
    const first = merge(encode(all));
    const again = merge(encode(all).map((b) => (" " + b).slice(1)));
    expect(again).toBe(first);
  });

  it("returns new data as soon as any blob changes (no stale serve)", () => {
    const merge = createFacilityMergeMemo();
    const before = merge(encode(all));
    const edited = all.map((f, i) => (i === 0 ? { ...f, name: f.name + " (edited)" } : f)) as Facility[];
    const after = merge(encode(edited));
    expect(after).not.toBe(before);
    expect(after.some((f) => f.name.endsWith(" (edited)"))).toBe(true);
    expect(before.some((f) => f.name.endsWith(" (edited)"))).toBe(false);
  });
});
