import { cache as reactCache } from "react";
import { unstable_cache } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import sitingContextRaw from "@/data/siting-context.json";
import { getDb, readsUseDatabase } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { sitingContextTable } from "@/lib/db/schema";
import { sitingContextSchema, waterStressSchema } from "@/lib/siting-context-schema";

/**
 * Nearest named surface-water feature to a facility, straight-line distance.
 * Source: USGS National Hydrography Dataset.
 */
export interface NearestWater {
  name: string;
  kind: "river" | "lake";
  distanceMi: number;
}

/**
 * Nearest high-voltage (>=230kV) electric transmission line to a facility,
 * straight-line distance. Source: HIFLD. This is a siting signal, not a
 * stated interconnection.
 */
export interface NearestTransmission {
  voltageKv: number;
  distanceMi: number;
}

/**
 * Baseline water-stress category for the surrounding hydrological basin.
 * Source: WRI Aqueduct 4.0. Describes the basin, not this facility's
 * measured water use.
 */
export interface WaterStress {
  cat: number;
  label: string;
}

/**
 * Groundwater-level decline trend for the surrounding hydrological basin.
 * Source: WRI Aqueduct 4.0. Same basin-not-facility caveat as WaterStress.
 */
export interface GroundwaterDecline {
  cat: number;
  label: string;
}

/**
 * Principal aquifer system underlying the location, mapped at coarse
 * (1:2,500,000) regional resolution. Source: USGS. Regional context, not
 * site hydrogeology.
 */
export interface Aquifer {
  name: string;
  rock: string;
}

/**
 * Pre-computed siting-context entry for one facility. Any field may be
 * absent even when the facility has an entry at all.
 */
export interface SitingContext {
  nearestWater?: NearestWater;
  nearestTransmission?: NearestTransmission;
  waterStress?: WaterStress;
  groundwaterDecline?: GroundwaterDecline;
  aquifer?: Aquifer;
}

// The zod schemas live in a JSON-free module (scripts/export.ts loads them before
// data/siting-context.json exists); re-exported so importers are unchanged.
export { sitingContextSchema };

// Pure formatters live in a JSON-free module so client components (the map
// popup) can use them without bundling data/siting-context.json.
export { formatNearestWater, formatNearestTransmission } from "@/lib/siting-format";

/**
 * Splits a risk label like "Extremely High (>80%)" into a prominent
 * category word ("Extremely High") and a muted parenthetical detail
 * (">80%"). Used by waterStress/groundwaterDecline rendering — the
 * category carries the meaning (Ed is color-deficient; never rely on a
 * severity tint alone). Labels without a parenthetical return no detail.
 */
export function splitRiskLabel(label: string): {
  category: string;
  detail?: string;
} {
  const match = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { category: label.trim() };
  return { category: match[1].trim(), detail: match[2].trim() };
}

/**
 * Siting context lives in the `siting_context` Neon table (keyed jsonb, one row
 * per facility). The bundled `data/siting-context.json` is kept ONLY as the
 * fallback for a Neon throw, an invalid row, or (whole-table readers) an empty
 * table. A missing per-facility row means "no data". The bundled JSON has an entry for every facility (a facility
 * matching no siting dataset still gets `{}`); the coverage test in `lib/siting-context.test.ts` checks that JSON
 * only, not the Neon table.
 *
 * Two readers, shaped around `unstable_cache`'s 2MB entry limit (envelope
 * included; an oversized entry is silently NOT stored, so every read misses and
 * hits Neon). The whole table is ~1.3MB of JSON and grows ~420 B per facility,
 * so it is never cached as one entry:
 *  - `getSitingContext(id)`: one small entry per facility (~0.4KB), for the
 *    facility page and the map popup route.
 *  - `getWaterStressById()`: only the `waterStress` projection of every row
 *    (~100 B per facility), for the one aggregate that needs every facility.
 */
const sitingContextFallback = sitingContextRaw as Record<string, SitingContext>;

/** Storage seam: the Neon implementation below, a fake in tests. */
export interface SitingSource {
  /** The stored `data` for one facility, or undefined when it has no row. */
  one(id: string): Promise<unknown | undefined>;
  /** `facility_id -> data.waterStress` for every row that has one. */
  waterStress(): Promise<Map<string, unknown>>;
}

export const neonSitingSource: SitingSource = {
  async one(id) {
    const rows = await getDb()
      .select({ data: sitingContextTable.data })
      .from(sitingContextTable)
      .where(eq(sitingContextTable.facilityId, id));
    return rows[0]?.data;
  },
  async waterStress() {
    const rows = await getDb()
      .select({
        id: sitingContextTable.facilityId,
        waterStress: sql<unknown>`${sitingContextTable.data} -> 'waterStress'`,
      })
      .from(sitingContextTable)
      .where(sql`${sitingContextTable.data} -> 'waterStress' is not null`);
    return new Map(rows.map((r) => [r.id, r.waterStress]));
  },
};

function warnFallback(what: string, err: unknown): void {
  // SQLSTATE only, never the error object (see lib/db-error.ts).
  console.warn(
    `[siting-context] Neon ${what} failed, falling back to bundled JSON snapshot (sqlstate: ${redactedErrorCode(err)})`
  );
}

/** A JSON null on a field means the same as absent: drop the key so the stored shape matches `SitingContext`. */
function withoutNulls(parsed: z.infer<typeof sitingContextSchema>): SitingContext {
  return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null));
}

// The `read*` functions return ONLY validated Neon data and THROW on a Neon
// error or an invalid row (`readWaterStress` also on an empty table;
// `readSitingContext` returns undefined for a missing row). They are what `unstable_cache`
// wraps: a thrown callback is never stored (next/dist/.../unstable-cache.js
// awaits the callback before `cacheNewResult`), so the JSON snapshot can never
// be cached for 24h by one transient failure. The snapshot fallback lives only
// in the loaders and getters, OUTSIDE the cache.

/** One facility's validated Neon entry; `undefined` when it has no row. Throws on an invalid row. */
async function readSitingContext(id: string, source: SitingSource): Promise<SitingContext | undefined> {
  const data = await source.one(id);
  if (data === undefined) return undefined;
  const parsed = sitingContextSchema.safeParse(data);
  if (!parsed.success) throw new Error("invalid siting_context row");
  return withoutNulls(parsed.data);
}

/** `facility_id -> waterStress` from Neon. Throws on an empty table or any invalid entry; a JSON-null entry is skipped. */
async function readWaterStress(source: SitingSource): Promise<Record<string, WaterStress>> {
  const rows = await source.waterStress();
  if (rows.size === 0) throw new Error("siting_context water-stress read returned no rows");
  const out: Record<string, WaterStress> = {};
  for (const [id, ws] of rows) {
    if (ws === null) continue;
    const parsed = waterStressSchema.safeParse(ws);
    if (!parsed.success) throw new Error("invalid siting_context waterStress entry");
    out[id] = parsed.data;
  }
  return out;
}

function waterStressFromJson(): Record<string, WaterStress> {
  const out: Record<string, WaterStress> = {};
  for (const [id, entry] of Object.entries(sitingContextFallback)) {
    if (entry.waterStress) out[id] = entry.waterStress;
  }
  return out;
}

/**
 * One facility's entry. Neon is the source of truth: a missing row means "no
 * data" (undefined), never the JSON snapshot. The snapshot is the fallback only
 * for a throw, an invalid row, or a read that may not use the database.
 */
export async function loadSitingContextUncached(
  id: string,
  source: SitingSource = neonSitingSource
): Promise<SitingContext | undefined> {
  if (!readsUseDatabase()) return sitingContextFallback[id];
  try {
    return await readSitingContext(id, source);
  } catch (err) {
    warnFallback("read", err);
    return sitingContextFallback[id];
  }
}

/** `facility_id -> waterStress`: Neon, else the JSON snapshot on a throw, invalid entry, or empty table. */
export async function loadWaterStressByIdUncached(
  source: SitingSource = neonSitingSource
): Promise<Record<string, WaterStress>> {
  if (!readsUseDatabase()) return waterStressFromJson();
  try {
    return await readWaterStress(source);
  } catch (err) {
    warnFallback("water-stress read", err);
    return waterStressFromJson();
  }
}

// `unstable_cache` needs the Next request-scoped cache context, absent under
// vitest: the getters degrade to the uncached loaders there, as lib/data.ts does.
// `null`, not undefined, crosses the cache boundary (JSON has no undefined).
const cachedOne = (id: string): Promise<SitingContext | null> =>
  unstable_cache(
    async () => (await readSitingContext(id, neonSitingSource)) ?? null,
    ["siting-context", id],
    // Scoped tag, not "facilities": the facility page must not re-acquire the
    // global tag (see lib/data.ts). 24h timer is the backstop.
    { tags: [`facility:${id}`], revalidate: 86400 }
  )();

// Inside an RSC render, reactCache memoizes the promise (rejection included), so
// an outage costs at most one Neon read per request per key. Outside a render
// (and under vitest) it is a passthrough and gives no dedupe.
const requestScopedOne = reactCache(cachedOne);

/** Cached per-facility lookup; also deduped within one render. The fallback is applied outside the cache. */
export async function getSitingContext(id: string): Promise<SitingContext | undefined> {
  if (process.env.VITEST || !readsUseDatabase()) return loadSitingContextUncached(id);
  try {
    return (await requestScopedOne(id)) ?? undefined;
  } catch (err) {
    warnFallback("read", err);
    return sitingContextFallback[id];
  }
}

const cachedWaterStress = reactCache(
  unstable_cache(() => readWaterStress(neonSitingSource), ["siting-context", "water-stress"], {
    tags: ["facilities"],
    revalidate: 86400,
  })
);

/** Cached `facility_id -> waterStress` map for the aggregate water-stress stat. The fallback is applied outside the cache. */
export async function getWaterStressById(): Promise<Record<string, WaterStress>> {
  if (process.env.VITEST || !readsUseDatabase()) return loadWaterStressByIdUncached();
  try {
    return await cachedWaterStress();
  } catch (err) {
    warnFallback("water-stress read", err);
    return waterStressFromJson();
  }
}

/** True when the entry carries at least one displayable datum. */
export function hasSitingDatum(context: SitingContext | undefined): context is SitingContext {
  return !!(
    context &&
    (context.nearestWater ||
      context.nearestTransmission ||
      context.waterStress ||
      context.groundwaterDecline ||
      context.aquifer)
  );
}
