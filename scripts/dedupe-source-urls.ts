/**
 * ONE-TIME migration: collapses duplicate source URLs within a facility's
 * `sources[]` and remaps every `sourceIndex` that points past the collapse.
 *
 * WHY THIS EXISTS. `applyEnrichmentUpdate` appended every proposed source
 * unconditionally, so the enrichment lane re-citing a page it had already read
 * added a second copy. Measured 2026-09-14 across 1,758 records: 283 redundant
 * entries in 262 duplicate groups across 235 records. The harm is inflated
 * provenance — a facility showing 5 sources that is really corroborated by 3.
 *
 * ⛔ RUN THE WRITE-PATH FIX FIRST. `lib/enrichment-update.ts` now points a
 * re-cited URL at its existing index instead of appending. 181 of the 262
 * groups involve the last index, i.e. the lane is an ACTIVE generator, not a
 * historical artifact — migrating before that fix ships just refills the hole.
 *
 * ★★ WHY THE SCHEMA CANNOT VALIDATE THIS MIGRATION, AND WHAT DOES.
 * `facilitySchema`'s `checkSourceIndexBounds` only rejects an OUT-OF-RANGE
 * `sourceIndex`. Deduping shifts indices strictly DOWNWARD, which is always
 * back into range — so a ref remapped onto the WRONG source passes validation
 * in silence. Bounds are the wrong invariant here.
 *
 * The right one is URL IDENTITY: for every `sourceIndex` in the record, the URL
 * it resolved to BEFORE must equal the URL it resolves to AFTER. That is
 * exactly checkable, and it is the only assertion in this script that can fail
 * for the right reason. It is enforced per-record below and the whole record is
 * abandoned if it trips.
 *
 * MERGE RULES — deliberately identical to `mergeRecitedSource` in
 * lib/enrichment-update.ts, so the migration and the write path cannot drift:
 *   url    — the collapse key, by definition identical.
 *   label  — KEEP THE FIRST occurrence. 102 groups disagree; the first is the
 *            earlier-curated one. A "keep the longest" rule is tempting and
 *            slightly more informative, but it overwrites curated text on the
 *            strength of a heuristic, and it would put this script out of step
 *            with the write path. Count is reported so the disagreements stay
 *            visible rather than silently resolved.
 *   kind   — carries a schema default of "other", so "other" cannot be
 *            distinguished from a deliberate choice. Upgrade "other" to a
 *            specific value when a copy offers one; if two copies disagree on
 *            two DIFFERENT specific values, that is a real conflict — the
 *            record is SKIPPED and reported, never silently resolved.
 *   publisher  — fill from the first copy that has one; never overwrite.
 *   retrievedAt — take the MAXIMUM. Each copy is a real fetch of the same URL,
 *            so the latest is the most recent verification. Strict YYYY-MM-DD
 *            (sourceSchema) makes lexicographic comparison date-correct.
 *
 * Usage:
 *   npx tsx scripts/dedupe-source-urls.ts            # dry run, prints the plan
 *   npx tsx scripts/dedupe-source-urls.ts --write    # rewrites data/facilities.json
 *
 * Then the normal wave tail: `npm run db:sync` (review) -> `-- --apply` ->
 * `npm run db:export`. No coordinates change, so `build:mapdata` is not needed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitySchema } from "../lib/schema";
import type { Facility, Source } from "../lib/schema";

const WRITE = process.argv.includes("--write");
const DATA_PATH = path.join(process.cwd(), "data", "facilities.json");

/** Every `sourceIndex` a facility carries, with a human-readable location. */
function sourceIndexRefs(f: Facility): { where: string; idx: number }[] {
  const refs: { where: string; idx: number }[] = [];
  const push = (where: string, idx: number | undefined) => {
    if (typeof idx === "number") refs.push({ where, idx });
  };
  f.statusHistory.forEach((h, i) => push(`statusHistory[${i}]`, h.sourceIndex));
  f.subsidies?.forEach((s, i) => push(`subsidies[${i}]`, s.sourceIndex));
  f.stakeholders?.forEach((s, i) => push(`stakeholders[${i}]`, s.sourceIndex));
  push("jobs", f.jobs?.sourceIndex);
  push("community", f.community?.sourceIndex);
  push("emissions", f.emissions?.sourceIndex);
  return refs;
}

/**
 * Applies a remap to every `sourceIndex` in place on a cloned facility.
 *
 * Two helpers rather than one, because the schema is asymmetric on purpose:
 * `stakeholders[].sourceIndex` is REQUIRED — a named person's documented stake
 * must cite something — while statusHistory/subsidies/jobs/community/emissions
 * leave it optional. A single `number | undefined` helper would force a cast at
 * the stakeholder site and quietly erase that distinction.
 */
function remapRefs(f: Facility, map: Map<number, number>): void {
  const remap = (idx: number): number => map.get(idx) ?? idx;
  const remapOptional = (idx: number | undefined): number | undefined =>
    typeof idx === "number" ? remap(idx) : idx;

  f.statusHistory.forEach((h) => {
    h.sourceIndex = remapOptional(h.sourceIndex);
  });
  f.subsidies?.forEach((s) => {
    s.sourceIndex = remapOptional(s.sourceIndex);
  });
  f.stakeholders?.forEach((s) => {
    s.sourceIndex = remap(s.sourceIndex);
  });
  if (f.jobs) f.jobs.sourceIndex = remapOptional(f.jobs.sourceIndex);
  if (f.community) f.community.sourceIndex = remapOptional(f.community.sourceIndex);
  if (f.emissions) f.emissions.sourceIndex = remapOptional(f.emissions.sourceIndex);
}

export interface RecordOutcome {
  id: string;
  removed: number;
  refsRemapped: number;
  labelDisagreements: number;
  skipped?: string;
}

export function dedupeRecord(original: Facility): { next: Facility; outcome: RecordOutcome } | null {
  const srcs = original.sources;
  const firstIndexByUrl = new Map<string, number>();
  srcs.forEach((s, i) => {
    if (!firstIndexByUrl.has(s.url)) firstIndexByUrl.set(s.url, i);
  });
  if (firstIndexByUrl.size === srcs.length) return null; // nothing to do

  const outcome: RecordOutcome = {
    id: original.id,
    removed: srcs.length - firstIndexByUrl.size,
    refsRemapped: 0,
    labelDisagreements: 0,
  };

  // Build the collapsed array, merging each duplicate group into its first copy.
  const groups = new Map<string, number[]>();
  srcs.forEach((s, i) => {
    const g = groups.get(s.url);
    if (g) g.push(i);
    else groups.set(s.url, [i]);
  });

  const kept: Source[] = [];
  const oldToNew = new Map<number, number>();
  for (const [url, idxs] of groups) {
    const copies = idxs.map((i) => srcs[i]);
    const merged: Source = { ...copies[0] };

    if (copies.some((c) => c.label !== merged.label)) outcome.labelDisagreements++;

    for (const c of copies.slice(1)) {
      if (merged.publisher === undefined && c.publisher !== undefined) merged.publisher = c.publisher;
      if (c.retrievedAt > merged.retrievedAt) merged.retrievedAt = c.retrievedAt;
    }

    const specific = [...new Set(copies.map((c) => c.kind).filter((k) => k !== "other"))];
    if (specific.length > 1) {
      return {
        next: original,
        outcome: {
          ...outcome,
          skipped: `conflicting source kinds for ${url}: ${specific.join(" vs ")}`,
        },
      };
    }
    if (specific.length === 1) merged.kind = specific[0];

    const newIdx = kept.length;
    kept.push(merged);
    for (const i of idxs) oldToNew.set(i, newIdx);
  }

  const before = sourceIndexRefs(original).map((r) => ({ ...r, url: srcs[r.idx]?.url }));

  const next: Facility = JSON.parse(JSON.stringify(original));
  next.sources = kept;
  remapRefs(next, oldToNew);

  // ★ The assertion that matters. Bounds cannot catch an in-range-but-wrong
  // ref; URL identity can. A trip abandons the record rather than writing it.
  const after = sourceIndexRefs(next);
  if (after.length !== before.length) {
    return { next: original, outcome: { ...outcome, skipped: "ref count changed during remap" } };
  }
  for (let i = 0; i < before.length; i++) {
    const wasUrl = before[i].url;
    const nowUrl = next.sources[after[i].idx]?.url;
    if (wasUrl !== nowUrl) {
      return {
        next: original,
        outcome: {
          ...outcome,
          skipped: `${before[i].where}: pointed at ${wasUrl ?? "<none>"}, would point at ${nowUrl ?? "<none>"}`,
        },
      };
    }
  }
  outcome.refsRemapped = before.filter((b, i) => b.idx !== after[i].idx).length;

  const parsed = facilitySchema.safeParse(next);
  if (!parsed.success) {
    return {
      next: original,
      outcome: { ...outcome, skipped: `facilitySchema rejected: ${parsed.error.issues[0]?.message}` },
    };
  }

  return { next, outcome };
}

function main(): void {
  const all = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as Facility[];
  const out: Facility[] = [];
  const changed: RecordOutcome[] = [];
  const skipped: RecordOutcome[] = [];

  for (const f of all) {
    const res = dedupeRecord(f);
    if (!res) {
      out.push(f);
      continue;
    }
    if (res.outcome.skipped) {
      skipped.push(res.outcome);
      out.push(f);
      continue;
    }
    changed.push(res.outcome);
    out.push(res.next);
  }

  const removed = changed.reduce((a, c) => a + c.removed, 0);
  const remapped = changed.reduce((a, c) => a + c.refsRemapped, 0);
  const labelDis = changed.reduce((a, c) => a + c.labelDisagreements, 0);

  console.log(`scanned ${all.length} facilities`);
  console.log(`records deduped     : ${changed.length}`);
  console.log(`redundant entries removed : ${removed}`);
  console.log(`sourceIndex refs remapped : ${remapped}  (all URL-identity verified)`);
  console.log(`label disagreements kept as the FIRST copy's label : ${labelDis}`);
  console.log(`records SKIPPED (need a human) : ${skipped.length}`);
  for (const s of skipped) console.log(`   ⚠ ${s.id} — ${s.skipped}`);

  const totalBefore = all.reduce((a, f) => a + f.sources.length, 0);
  const totalAfter = out.reduce((a, f) => a + f.sources.length, 0);
  console.log(`\nsource entries: ${totalBefore} -> ${totalAfter}  (-${totalBefore - totalAfter})`);

  if (WRITE) {
    writeFileSync(DATA_PATH, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n✅ wrote ${DATA_PATH}`);
  } else {
    console.log(`\n(dry run — re-run with --write to apply)`);
  }
}

// Guarded so the test suite can import `dedupeRecord` without executing the
// migration — the same `isMain` pattern scripts/normalize-county-suffixes.ts uses.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
