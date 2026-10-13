import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import {
  FACILITY_CACHE_SHARDS,
  encodeFacilityShard,
  facilityShard,
  mergeFacilityShards,
} from "@/lib/data";
import type { Facility } from "@/lib/schema";

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
      const mine = facilities.filter((f) => facilityShard(f.id) === shard);
      const bytes = gzipSync(Buffer.from(JSON.stringify(mine), "utf8")).toString("base64").length;
      expect(bytes, `shard ${shard} (${mine.length} records)`).toBeLessThan(SHARD_BUDGET_BYTES);
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
});
