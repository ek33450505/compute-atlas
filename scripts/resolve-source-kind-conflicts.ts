/**
 * ONE-TIME migration: resolves the 9 `sources[]` duplicate-URL groups that
 * `scripts/dedupe-source-urls.ts` refuses to collapse because the two copies
 * carry two DIFFERENT specific `kind` values.
 *
 * WHY THIS EXISTS. `dedupe-source-urls.ts` deliberately SKIPS a record when a
 * duplicate URL's copies disagree on a specific (non-"other") `kind` — picking
 * one silently would destroy a curated judgement, so it bails and reports the
 * conflict instead. Measured against `data/facilities.json` on 2026-09-14,
 * exactly 9 records tripped that guard, and all nine are the same shape: a
 * document that REPORTS ON a permit / filing / subsidy, tagged `press` by one
 * enrichment pass and `permit` / `filing` / `subsidy` by another.
 *
 * The maintainer (Ed) resolved all nine on 2026-09-14 with a SPLIT rule, not a
 * universal one:
 *
 *   `kind` describes what the document IS, not what it is ABOUT — EXCEPT when
 *   the publisher is the granting party itself, in which case the page IS
 *   first-party subsidy evidence, not reportage.
 *
 * So 5 records collapse to `press` (the page is a newspaper / trade outlet /
 * company press release reporting on something) and 4 stay `subsidy` (the page
 * is published BY the state economic-development agency granting the
 * incentive). The three agency domains below were verified by fetching their
 * `<title>` on 2026-09-14: mississippi.org = "Mississippi Development
 * Authority"; tnecd.com = "Tennessee Department of Economic and Community
 * Development"; opportunitylouisiana.gov = "Louisiana Economic Development".
 *
 * This is a PER-RECORD CURATION DECISION, deliberately encoded here as an
 * explicit table rather than folded into `dedupe-source-urls.ts` as a
 * heuristic. The whole point of that script's skip is that this call needs a
 * human — automating the split rule there would defeat the guard it exists to
 * provide. This script is a ONE-TIME migration that stays committed after it
 * runs, same precedent as `scripts/dedupe-source-urls.ts` and
 * `scripts/normalize-county-suffixes.ts`.
 *
 * Resolving the conflict UNBLOCKS THE WHOLE RECORD for the dedupe pass,
 * including duplicate groups in the same record that had no kind conflict at
 * all — e.g. `avaio-taurus-brandon-ms` also has an unrelated 2-copy group and
 * `compass-lauderdale-meridian-ms` an unrelated 3-copy group that were skipped
 * only as collateral damage from the one conflicting group. So the follow-up
 * `dedupe-source-urls.ts --write` run is expected to remove 13 entries across
 * these 9 records (5,258 -> 5,245), not 9.
 *
 * This script changes ONLY the `kind` field at the listed indices — it does
 * NOT collapse the duplicates. Collapsing is `dedupe-source-urls.ts`'s job on
 * the follow-up run.
 *
 * Usage:
 *   npx tsx scripts/resolve-source-kind-conflicts.ts            # dry run
 *   npx tsx scripts/resolve-source-kind-conflicts.ts --write    # applies
 *
 * Then: npx tsx scripts/dedupe-source-urls.ts --write, followed by the normal
 * wave tail (`npm run db:sync` -> `-- --apply` -> `npm run db:export`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitySchema, sourceKindEnum } from "../lib/schema";
import type { Facility } from "../lib/schema";
import type { z } from "zod";

const WRITE = process.argv.includes("--write");
const DATA_PATH = path.join(process.cwd(), "data", "facilities.json");

// lib/schema.ts exports the enum itself but not a standalone type alias for
// it; derive one here rather than re-declaring the vocabulary by hand.
type SourceKind = z.infer<typeof sourceKindEnum>;

/** One row of the reviewed resolution table — the reviewable unit is the `reason`. */
interface Resolution {
  id: string;
  url: string;
  /** Indices at which `url` is expected to appear, in ascending order. */
  indices: number[];
  /** The `kind` currently expected at each of `indices`, same order. */
  currentKinds: SourceKind[];
  /** The `kind` every listed index should carry after this migration. */
  resolvedKind: SourceKind;
  reason: string;
}

// Verified against data/facilities.json at commit b26ec43 (2026-09-14).
export const RESOLUTIONS: Resolution[] = [
  // --- resolve to "subsidy": publisher IS the granting agency ---
  {
    id: "avaio-taurus-brandon-ms",
    url: "https://mississippi.org/news/avaio-digital-to-locate-6-billion-data-center-campus-in-rankin-county/",
    indices: [2, 7, 9],
    currentKinds: ["subsidy", "press", "subsidy"],
    resolvedKind: "subsidy",
    reason: "Mississippi Development Authority announcing its own incentive.",
  },
  {
    id: "compass-lauderdale-meridian-ms",
    url: "https://mississippi.org/news/compass-datacenters-project-generates-10-billion-investment-in-lauderdale-county/",
    indices: [0, 7],
    currentKinds: ["press", "subsidy"],
    resolvedKind: "subsidy",
    reason: "Mississippi Development Authority announcing its own incentive.",
  },
  {
    id: "litewire-mcminnville-tn",
    url: "https://tnecd.com/news/litewire-llc-to-open-new-facility-in-warren-county/",
    indices: [0, 2],
    currentKinds: ["subsidy", "press"],
    resolvedKind: "subsidy",
    reason:
      "Tennessee Dept of Economic and Community Development announcing its own incentive.",
  },
  {
    id: "stack-bossier-parish-la",
    url: "https://www.opportunitylouisiana.gov/news/amazon-selects-louisiana-for-12-billion-data-center-campuses-in-major-u-s-expansion",
    indices: [1, 2],
    currentKinds: ["subsidy", "press"],
    resolvedKind: "subsidy",
    reason: "Louisiana Economic Development announcing its own incentive.",
  },
  // --- resolve to "press": the document IS reportage or a company press release ---
  {
    id: "core-scientific-muskogee-ok",
    url: "https://investors.corescientific.com/news-events/press-releases/detail/135/core-scientific-plans-expansion-to-1-5-gigawatts-of-gross-power-at-muskogee-oklahoma-campus",
    indices: [0, 4],
    currentKinds: ["filing", "press"],
    resolvedKind: "press",
    reason:
      "an investor-relations PRESS RELEASE, not an SEC filing; the path is /press-releases/.",
  },
  {
    id: "coresite-or1-orlando-fl",
    url: "https://www.growthspotter.com/2026/06/02/coresite-looks-to-add-second-orlando-data-center-building/",
    indices: [0, 2],
    currentKinds: ["press", "permit"],
    resolvedKind: "press",
    reason:
      "GrowthSpotter is a trade news outlet reporting on a permit application, not the permit.",
  },
  {
    id: "flexential-salisbury-henderson-grove-nc",
    url: "https://www.salisburypost.com/2026/08/12/salisbury-planning-recommends-henderson-grove-church-data-center-approval/",
    indices: [0, 2],
    currentKinds: ["permit", "press"],
    resolvedKind: "press",
    reason: "the Salisbury Post is a local newspaper reporting a planning recommendation.",
  },
  {
    id: "orient-energy-center-ia",
    url: "https://www.midamericanenergy.com/newsroom/2025-generation-projects",
    indices: [0, 2],
    currentKinds: ["filing", "press"],
    resolvedKind: "press",
    reason: "a utility NEWSROOM page, the company's own announcement, not a regulatory filing.",
  },
  {
    id: "pointone-lower-moncure-road-lee-county-nc",
    url: "https://sandhills.news/2026/06/08/lee-county-pointone-data-center/",
    indices: [0, 2],
    currentKinds: ["permit", "press"],
    resolvedKind: "press",
    reason: "Sandhills News is a local news outlet reporting on a county data-center item.",
  },
];

export interface ResolutionOutcome {
  id: string;
  url: string;
  before: SourceKind[];
  after: SourceKind;
  alreadyResolved: boolean;
}

/** Sorted-copy equality — order-independent, as `indices` and `currentKinds` are index-order not sort-order for kinds. */
function sameIndices(a: number[], b: number[]): boolean {
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

function sameMultiset<T>(a: T[], b: T[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * Applies one resolution to a cloned facility. Throws on ANY precondition
 * failure (id missing, url at unexpected indices, kinds not the expected
 * multiset) rather than mis-editing — this runs against a file other tooling
 * rewrites, so it must fail loudly if the data moved underneath it.
 *
 * Idempotent-safe in the useful direction: if every listed index already
 * carries `resolvedKind`, this reports `alreadyResolved: true` and mutates
 * nothing, instead of throwing.
 */
export function applyResolution(
  facility: Facility,
  r: Resolution,
): { next: Facility; outcome: ResolutionOutcome } {
  if (facility.id !== r.id) {
    throw new Error(`applyResolution called with mismatched facility ${facility.id} for ${r.id}`);
  }

  const actualIndices: number[] = [];
  facility.sources.forEach((s, i) => {
    if (s.url === r.url) actualIndices.push(i);
  });

  if (!sameIndices(actualIndices, r.indices)) {
    throw new Error(
      `${r.id}: expected "${r.url}" at indices [${r.indices.join(",")}], found it at [${actualIndices
        .sort((a, b) => a - b)
        .join(",")}] — data has moved, aborting.`,
    );
  }

  const sortedIdx = [...r.indices].sort((a, b) => a - b);
  const actualKinds = sortedIdx.map((i) => facility.sources[i].kind);

  if (actualKinds.every((k) => k === r.resolvedKind)) {
    return {
      next: facility,
      outcome: { id: r.id, url: r.url, before: actualKinds, after: r.resolvedKind, alreadyResolved: true },
    };
  }

  if (!sameMultiset(actualKinds, r.currentKinds)) {
    throw new Error(
      `${r.id}: expected kinds [${r.currentKinds.join(",")}] at "${r.url}", found [${actualKinds.join(
        ",",
      )}] — data has moved, aborting.`,
    );
  }

  const next: Facility = JSON.parse(JSON.stringify(facility));
  for (const i of sortedIdx) next.sources[i].kind = r.resolvedKind;

  const parsed = facilitySchema.safeParse(next);
  if (!parsed.success) {
    throw new Error(`${r.id}: facilitySchema rejected after resolution: ${parsed.error.issues[0]?.message}`);
  }

  return {
    next,
    outcome: { id: r.id, url: r.url, before: actualKinds, after: r.resolvedKind, alreadyResolved: false },
  };
}

function main(): void {
  const all = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as Facility[];
  const byId = new Map(all.map((f) => [f.id, f]));

  const outcomes: ResolutionOutcome[] = [];
  const updated = new Map<string, Facility>();

  for (const r of RESOLUTIONS) {
    const facility = byId.get(r.id);
    if (!facility) {
      throw new Error(`${r.id}: facility not found in ${DATA_PATH} — aborting, nothing written.`);
    }
    const current = updated.get(r.id) ?? facility;
    const { next, outcome } = applyResolution(current, r);
    outcomes.push(outcome);
    updated.set(r.id, next);
  }

  console.log(`resolutions in table : ${RESOLUTIONS.length}`);
  for (const o of outcomes) {
    const tag = o.alreadyResolved ? "already resolved" : "resolved";
    console.log(`  [${tag}] ${o.id}  ${o.url}`);
    console.log(`      [${o.before.join(", ")}] -> ${o.after}`);
  }

  const applied = outcomes.filter((o) => !o.alreadyResolved).length;
  const already = outcomes.filter((o) => o.alreadyResolved).length;
  console.log(`\napplied : ${applied}`);
  console.log(`already resolved (skipped) : ${already}`);

  if (WRITE) {
    const out = all.map((f) => updated.get(f.id) ?? f);
    writeFileSync(DATA_PATH, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`\n✅ wrote ${DATA_PATH}`);
  } else {
    console.log(`\n(dry run — re-run with --write to apply)`);
  }
}

// Guarded so the test suite can import `applyResolution`/`RESOLUTIONS` without
// executing the migration — the same `isMain` pattern dedupe-source-urls.ts uses.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
