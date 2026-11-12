/**
 * check-siting-additive.mjs
 *
 * Fail-closed guard: refuses to let a regenerated data/siting-context.next.json
 * silently LOSE data relative to the LIVE Neon `siting_context` rows.
 *
 * Background: `npm run build:mapdata` recomputes per-facility siting context
 * from live external APIs (USGS NHD, HIFLD, WRI Aqueduct) and writes
 * data/siting-context.next.json (gitignored; never data/siting-context.json).
 * build-map-data.mjs's `resolveNearestWater` carries a prior `nearestWater`
 * forward on any unconfirmed/partial NHD response (gate: `absenceConfirmed !==
 * true`), so a degraded-but-not-down NHD does not drop that field on its own.
 * Only a genuinely confirmed absence clears it (that is what lets a corrected
 * coordinate clear a stale value). Both this guard and siting:apply refuse
 * that: an omitted key is reported as `lost` and the run exits 1. Today,
 * clearing a stale value therefore needs a reviewed change to the gate, or a
 * direct, reviewed Neon edit; there is no override flag.
 * `nearestTransmission` has no carry-forward: `fetchArcGISAll` verifies its
 * HIFLD page count and throws on a mismatch, so a `null` there is
 * authoritative. This guard remains the backstop for regressions in that logic
 * and for any field without an equivalent completeness check.
 *
 * BASELINE: the live Neon rows (the same table `siting:apply` writes), read
 * through an injected reader. Neon is the source of truth, so there is no git
 * ref, no fetch and no stale-HEAD false positive to design around.
 *
 * FACILITIES SOURCE: the snapshot data/facilities.json, which `db:export`
 * refreshes from Neon, not a Neon read. It is the same source `siting:apply`
 * uses, so the guard and the writer classify `pruned` identically, and it
 * avoids a second full read of the large `facilities` table (Neon egress).
 * Limit: a stale snapshot (export not run since a facility was retired or
 * added) can only misclassify an id that is ALSO dropped from the next file;
 * run `db:export` first.
 *
 * `pruned` vs `removed`: full and `--backfill-nhd` runs of build:mapdata seed
 * the id set from facilities.json ∪ computed results, so a retired facility
 * (absent from data/facilities.json) has its entry legitimately dropped.
 * A dropped id also absent from the snapshot is `pruned` (allowed); a dropped
 * id that still has a facility is `removed` (fails).
 *
 * Usage: tsx scripts/check-siting-additive.mjs   (tsx: the default reader
 *   imports lib/closed-data-store.ts)
 *   Exit 0: additive.
 *   Exit 1: DATA LOSS (offending ids/fields printed).
 *   Exit 2: the guard could not evaluate (missing/unparseable file, empty
 *           facilities list, empty siting_context table, no DATABASE_URL, Neon read failure). NOT a verdict.
 *   Callers must treat ONLY exit 1 as a data-loss verdict.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
export const NEXT_REL_PATH = "data/siting-context.next.json";
const FACILITIES_REL_PATH = "data/facilities.json";
const PRINT_LIMIT = 25;

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

/** JSON.stringify with object keys sorted recursively; arrays keep their order. */
function stableJson(value) {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  );
}

/**
 * Diff two siting-context objects (facility id -> entry object with optional
 * keys like nearestWater/nearestTransmission/waterStress/...).
 *
 * @param {Record<string, Record<string, unknown>>} oldObj
 * @param {Record<string, Record<string, unknown>>} newObj
 * @param {Set<string>} [liveIds] ids present in the CURRENT data/facilities.json.
 *   When supplied, an id dropped from siting-context.json that is ALSO absent
 *   from liveIds is a legitimate orphan (the facility itself was retired via a
 *   raw Neon delete) and is classified as `pruned`, not `removed`. When
 *   omitted, every dropped id goes to `removed` — identical to pre-`pruned`
 *   behaviour.
 * @returns {{
 *   added: string[],
 *   removed: string[],
 *   pruned: string[],
 *   lost: Array<{id: string, field: string, oldValue: unknown}>,
 *   nulled: Array<{id: string, field: string, oldValue: unknown}>,
 *   changed: Array<{id: string, field: string, oldValue: unknown, newValue: unknown}>,
 * }}
 */
export function diffSitingContext(oldObj, newObj, liveIds) {
  const safeOld = oldObj ?? {};
  const safeNew = newObj ?? {};

  const added = [];
  const removed = [];
  const pruned = [];
  const lost = [];
  const nulled = [];
  const changed = [];

  const newIdSet = new Set(Object.keys(safeNew));

  for (const id of Object.keys(safeNew)) {
    if (!(id in safeOld)) added.push(id);
  }

  for (const id of Object.keys(safeOld)) {
    if (!newIdSet.has(id)) {
      if (liveIds && !liveIds.has(id)) {
        pruned.push(id);
      } else {
        removed.push(id);
      }
      continue;
    }

    const oldEntry = safeOld[id] ?? {};
    const newEntry = safeNew[id] ?? {};

    for (const field of Object.keys(oldEntry)) {
      const oldValue = oldEntry[field];
      if (oldValue === undefined) continue; // nothing there to lose

      if (!(field in newEntry) || newEntry[field] === undefined) {
        lost.push({ id, field, oldValue });
        continue;
      }

      const newValue = newEntry[field];

      if (oldValue !== null && newValue === null) {
        nulled.push({ id, field, oldValue });
        continue;
      }

      // Compare canonically: one side may come from Neon, and Postgres jsonb
      // re-orders object keys (shorter first, then bytewise), so a plain
      // JSON.stringify reported ~6,000 false `changed` entries per run.
      if (stableJson(oldValue) !== stableJson(newValue)) {
        changed.push({ id, field, oldValue, newValue });
      }
    }
  }

  return { added, removed, pruned, lost, nulled, changed };
}

/**
 * True when the diff contains no data loss. `changed` never fails the
 * check — a genuinely nearer feature or a refreshed basin label is a
 * legitimate refresh, not a regression.
 * @param {ReturnType<typeof diffSitingContext>} diff
 */
export function isAdditive(diff) {
  return diff.removed.length === 0 && diff.lost.length === 0 && diff.nulled.length === 0;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function printSample(error, label, items, formatOne, limit = PRINT_LIMIT) {
  error(`\n${label} (${items.length}, showing up to ${limit}):`);
  for (const item of items.slice(0, limit)) {
    error(`  - ${formatOne(item)}`);
  }
}

/** A thrown reader failure is a guard error (exit 2), never a verdict. */
class GuardError extends Error {}

/**
 * @param {{
 *   readNext: () => Record<string, Record<string, unknown>>,
 *   readCurrent: () => Promise<Record<string, Record<string, unknown>>>,
 *   readFacilities: () => unknown,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} deps
 * @returns {Promise<0 | 1 | 2>}
 */
export async function runCheck({ readNext, readCurrent, readFacilities, log = console.log, error = console.error }) {
  const guardError = (msg) =>
    error(`[check-siting-additive] GUARD ERROR — could not evaluate; this is NOT a data-loss verdict: ${msg}`);

  let newObj;
  let facilities;
  let oldObj;
  try {
    // lint-no-raw-error-logs: allow -- local file reads; this file imports no DB code (the Neon reader is injected and reports only a fixed message)
    try { newObj = readNext(); } catch (err) { throw new GuardError(`failed to read/parse ${NEXT_REL_PATH}: ${err.message}`); }
    // lint-no-raw-error-logs: allow -- local file read
    try { facilities = readFacilities(); } catch (err) { throw new GuardError(`failed to read/parse ${FACILITIES_REL_PATH}: ${err.message}`); }
    try {
      oldObj = await readCurrent();
    } catch (err) {
      // The injected reader owns redaction; only a GuardError message is relayed.
      throw err instanceof GuardError ? err : new GuardError("could not read the live siting_context rows");
    }
  } catch (err) {
    guardError(err instanceof GuardError ? err.message : "unexpected failure");
    return 2;
  }

  if (typeof newObj !== "object" || newObj === null || Array.isArray(newObj)) {
    guardError(`${NEXT_REL_PATH} is not a JSON object keyed by facility id`);
    return 2;
  }
  // FAIL CLOSED: an empty list would make EVERY dropped id look like a retired orphan.
  if (!Array.isArray(facilities) || facilities.length === 0) {
    guardError(
      `${FACILITIES_REL_PATH} is not a non-empty array — refusing to run ` +
        `(an empty/malformed facility list would reclassify every removed id as an allowed prune).`,
    );
    return 2;
  }
  // FAIL CLOSED: an empty baseline compares against nothing, so every next entry
  // would read as an addition. Backfill Neon first.
  if (Object.keys(oldObj).length === 0) {
    guardError("siting_context is empty: run `npm run backfill:siting -- --apply` first");
    return 2;
  }
  const liveIds = new Set(facilities.map((facility) => facility.id));

  const diff = diffSitingContext(oldObj, newObj, liveIds);
  const additive = isAdditive(diff);

  log("=== siting-context.next.json additive check (vs live Neon siting_context) ===");
  log(`  added:   ${diff.added.length}`);
  log(`  removed: ${diff.removed.length}`);
  log(`  pruned:  ${diff.pruned.length}  (allowed — orphans with no facility in ${FACILITIES_REL_PATH})`);
  log(`  lost:    ${diff.lost.length}`);
  log(`  nulled:  ${diff.nulled.length}`);
  log(`  changed: ${diff.changed.length}  (allowed — refreshed values)`);

  if (diff.pruned.length) {
    log(`\nPruned facility ids (${diff.pruned.length}, showing up to ${PRINT_LIMIT}):`);
    for (const id of diff.pruned.slice(0, PRINT_LIMIT)) log(`  - ${id}`);
  }

  if (!additive) {
    error(
      "\n[check-siting-additive] DATA LOSS DETECTED — the regenerated " +
        "siting-context.next.json would lose data present in Neon.",
    );
    if (diff.removed.length) printSample(error, "Removed facility ids", diff.removed, (id) => id);
    if (diff.lost.length) {
      printSample(
        error,
        "Fields dropped",
        diff.lost,
        ({ id, field, oldValue }) => `${id}.${field}: was ${JSON.stringify(oldValue)} -> ABSENT`,
      );
    }
    if (diff.nulled.length) {
      printSample(
        error,
        "Fields nulled",
        diff.nulled,
        ({ id, field, oldValue }) => `${id}.${field}: was ${JSON.stringify(oldValue)} -> null`,
      );
    }
    return 1;
  }

  log("\n[check-siting-additive] OK — additive (or unchanged); no data loss detected.");
  return 0;
}

/** Default reader: live Neon rows, canonicalised (jsonb does not keep key order). */
async function readNeonSiting() {
  if (!process.env.DATABASE_URL) {
    throw new GuardError("DATABASE_URL is not set (the guard compares against the live rows)");
  }
  const { sitingStore, canonicalJson } = await import("../lib/closed-data-store.ts");
  const rows = await sitingStore().readAll();
  return Object.fromEntries([...rows].map(([k, v]) => [k, JSON.parse(canonicalJson(v))]));
}

// Symlink/space-safe entrypoint check — see scripts/is-entrypoint.ts (plain node cannot import .ts).
function isEntrypoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
  // An uncaught throw would exit 1, indistinguishable from the DATA LOSS
  // verdict; runCheck maps every failure it can see to 2 and this catches the rest.
  runCheck({
    readNext: () => readJson(NEXT_REL_PATH),
    readCurrent: readNeonSiting,
    readFacilities: () => readJson(FACILITIES_REL_PATH),
  }).then(
    (code) => process.exit(code),
    () => {
      console.error("[check-siting-additive] GUARD ERROR — could not evaluate; this is NOT a data-loss verdict.");
      process.exit(2);
    },
  );
}
