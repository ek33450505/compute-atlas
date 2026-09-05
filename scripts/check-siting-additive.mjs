/**
 * check-siting-additive.mjs
 *
 * Fail-closed guard: refuses to let a regenerated data/siting-context.json
 * silently LOSE data relative to the committed baseline at HEAD.
 *
 * Background: `npm run build:mapdata` recomputes per-facility siting context
 * from live external APIs (USGS NHD, HIFLD, WRI Aqueduct). On a transient
 * fetch failure, build-map-data.mjs's per-facility lookups can come back
 * empty; that path feeds `nearest: null`, and the field is then simply
 * OMITTED from the entry written to siting-context.json — the previously
 * good value is gone, with nothing to restore it. build-map-data.mjs's own
 * circuit breaker only aborts the whole build after N CONSECUTIVE total
 * failures, so a SCATTERED partial outage can drop fields across many
 * facilities while the build still exits 0. This script is the machine gate
 * that replaces the sync PR's unread "confirm changes are additive"
 * checklist item, since that PR auto-merges and no human reads it.
 *
 * Usage: node scripts/check-siting-additive.mjs
 *   Exits 1 (and prints the offending ids/fields) if the working-tree
 *   data/siting-context.json would lose data relative to HEAD's copy.
 *   Exits 0 if additive (including the case where HEAD has no baseline yet).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SITING_CONTEXT_REL_PATH = "data/siting-context.json";
const PRINT_LIMIT = 25;

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

/**
 * Diff two siting-context objects (facility id -> entry object with optional
 * keys like nearestWater/nearestTransmission/waterStress/...).
 *
 * @param {Record<string, Record<string, unknown>>} oldObj
 * @param {Record<string, Record<string, unknown>>} newObj
 * @returns {{
 *   added: string[],
 *   removed: string[],
 *   lost: Array<{id: string, field: string, oldValue: unknown}>,
 *   nulled: Array<{id: string, field: string, oldValue: unknown}>,
 *   changed: Array<{id: string, field: string, oldValue: unknown, newValue: unknown}>,
 * }}
 */
export function diffSitingContext(oldObj, newObj) {
  const safeOld = oldObj ?? {};
  const safeNew = newObj ?? {};

  const added = [];
  const removed = [];
  const lost = [];
  const nulled = [];
  const changed = [];

  const newIdSet = new Set(Object.keys(safeNew));

  for (const id of Object.keys(safeNew)) {
    if (!(id in safeOld)) added.push(id);
  }

  for (const id of Object.keys(safeOld)) {
    if (!newIdSet.has(id)) {
      removed.push(id);
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

      // Deep-compare via JSON.stringify — deliberately simple/deterministic
      // per spec; key order inside these small leaf objects is produced by
      // the same build code on both sides so this does not false-positive.
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changed.push({ id, field, oldValue, newValue });
      }
    }
  }

  return { added, removed, lost, nulled, changed };
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
// CLI
// ---------------------------------------------------------------------------

/** @returns {Record<string, unknown> | null} null means "no baseline to compare against" */
export function readBaselineFromGit(repoRoot, relPath) {
  let raw;
  try {
    raw = execFileSync("git", ["show", `HEAD:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    // Exit 128 is git's "that path or ref is not in HEAD" — the genuine
    // first-run case (a brand-new file, or a branch whose HEAD predates it),
    // and the ONLY reason this guard is allowed to stand down.
    if (err && err.status === 128) {
      return null;
    }
    // Anything else — git missing from PATH, permission denied, a corrupt
    // object store — is an ENVIRONMENT fault, not evidence that the baseline
    // is absent. Returning null here would disable the guard while the job
    // still reported green, which is the exact failure mode this guard exists
    // to prevent. Fail loudly instead.
    throw err;
  }
  // Deliberately OUTSIDE the try: a corrupt or truncated baseline blob must
  // fail loudly too. Treating unparseable JSON as "no baseline" would let real
  // data loss through on a green run.
  return JSON.parse(raw);
}

function readWorkingTree(repoRoot, relPath) {
  const raw = readFileSync(join(repoRoot, relPath), "utf8");
  return JSON.parse(raw);
}

function printSample(label, items, formatOne, limit = PRINT_LIMIT) {
  console.error(`\n${label} (${items.length}, showing up to ${limit}):`);
  for (const item of items.slice(0, limit)) {
    console.error(`  - ${formatOne(item)}`);
  }
}

function main() {
  const oldObj = readBaselineFromGit(REPO_ROOT, SITING_CONTEXT_REL_PATH);
  if (oldObj === null) {
    console.log(
      `[check-siting-additive] No baseline found at HEAD:${SITING_CONTEXT_REL_PATH} ` +
        `(first run, or git could not read it) — skipping the additive check.`,
    );
    process.exit(0);
    return;
  }

  let newObj;
  try {
    newObj = readWorkingTree(REPO_ROOT, SITING_CONTEXT_REL_PATH);
  } catch (err) {
    console.error(
      `[check-siting-additive] Failed to read/parse working-tree ${SITING_CONTEXT_REL_PATH}: ${err.message}`,
    );
    process.exit(1);
    return;
  }

  const diff = diffSitingContext(oldObj, newObj);
  const additive = isAdditive(diff);

  console.log("=== siting-context.json additive check (vs HEAD) ===");
  console.log(`  added:   ${diff.added.length}`);
  console.log(`  removed: ${diff.removed.length}`);
  console.log(`  lost:    ${diff.lost.length}`);
  console.log(`  nulled:  ${diff.nulled.length}`);
  console.log(`  changed: ${diff.changed.length}  (allowed — refreshed values)`);

  if (!additive) {
    console.error(
      "\n[check-siting-additive] DATA LOSS DETECTED — the regenerated " +
        "siting-context.json would lose data present at HEAD.",
    );
    if (diff.removed.length) {
      printSample("Removed facility ids", diff.removed, (id) => id);
    }
    if (diff.lost.length) {
      printSample(
        "Fields dropped",
        diff.lost,
        ({ id, field, oldValue }) => `${id}.${field}: was ${JSON.stringify(oldValue)} -> ABSENT`,
      );
    }
    if (diff.nulled.length) {
      printSample(
        "Fields nulled",
        diff.nulled,
        ({ id, field, oldValue }) => `${id}.${field}: was ${JSON.stringify(oldValue)} -> null`,
      );
    }
    process.exit(1);
    return;
  }

  console.log("\n[check-siting-additive] OK — additive (or unchanged); no data loss detected.");
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
