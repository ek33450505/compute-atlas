/**
 * check-siting-additive.mjs
 *
 * Fail-closed guard: refuses to let a regenerated data/siting-context.json
 * silently LOSE data relative to the committed baseline on the branch this
 * sync will MERGE INTO (origin/main), not the commit that happened to be
 * checked out when the job started.
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
 * WHY NOT HEAD: build:mapdata takes ~30 min. Anything merged during that
 * window leaves the checked-out HEAD stale, and a recomputation that is
 * CORRECT for the new state then reads as data loss. That is not
 * hypothetical: on 2026-09-08 the sync started at 12:36:57Z on 11f9d13, PR
 * #256 merged at 12:50:24Z correcting two Salt Lake City facilities off a
 * shared placeholder centroid (40.75962,-111.8868) onto real coordinates,
 * and at 13:09:08Z this guard flagged
 * `oracle-salt-lake-city-ut.groundwaterDecline` and
 * `senawave-salt-lake-city-ut.groundwaterDecline` as dropped. The old values
 * had been computed at a fabricated coordinate; the new absence was the
 * truthful result. The guard discarded correct data and held the PR open.
 * Diffing against current origin/main removes that whole class of false
 * positive, because the baseline is then the same state the rebuild
 * describes.
 *
 * FALLBACK IS CONSERVATIVE, NOT FAIL-OPEN: when origin/main cannot be
 * resolved this falls back to HEAD. HEAD is always at-or-behind origin/main
 * (main is protected and never force-pushed), so its baseline is a SUPERSET
 * of fields — strictly more that can be seen as lost. A failed fetch can
 * therefore only make this guard stricter, never more permissive.
 *
 * Usage: node scripts/check-siting-additive.mjs
 *   Exits 1 (and prints the offending ids/fields) if the working-tree
 *   data/siting-context.json would lose data relative to the baseline ref.
 *   Exits 0 if additive (including the case where the ref has no baseline yet).
 *   Env: SITING_BASELINE_REF overrides the preferred ref (default origin/main).
 *        SITING_BASELINE_NO_FETCH=1 skips the refresh fetch (offline/tests).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SITING_CONTEXT_REL_PATH = "data/siting-context.json";
const PRINT_LIMIT = 25;
export const PREFERRED_BASELINE_REF = "origin/main";
export const FALLBACK_BASELINE_REF = "HEAD";

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

/**
 * @param {string} ref git ref to read the baseline blob from (e.g. "origin/main")
 * @returns {Record<string, unknown> | null} null means "no baseline to compare against"
 */
export function readBaselineFromGit(repoRoot, relPath, ref = FALLBACK_BASELINE_REF) {
  let raw;
  try {
    raw = execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    // Exit 128 is git's "that path is not in <ref>" — the genuine first-run
    // case (a brand-new file, or a ref that predates it), and the ONLY reason
    // this guard is allowed to stand down. Callers must verify the ref itself
    // EXISTS first (see resolveBaselineRef), otherwise a missing ref would
    // arrive here as 128 and be misread as "no baseline yet", silently
    // disabling the guard on a green run.
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

/**
 * True if `ref` resolves in this repo. Used to tell "ref absent" (fall back)
 * apart from "path absent in ref" (genuine first-run), which `git show`
 * reports identically as exit 128.
 * @returns {boolean}
 */
export function refExists(repoRoot, ref, exec = execFileSync) {
  try {
    exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** @returns {boolean} true if this clone is shallow (a .git/shallow graft exists) */
export function isShallowRepo(repoRoot, exec = execFileSync) {
  try {
    const out = exec("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return String(out).trim() === "true";
  } catch {
    return false; // unknown -> assume full, which is the non-destructive branch
  }
}

/**
 * Best-effort refresh of the preferred baseline ref. The CI checkout is
 * shallow (actions/checkout defaults to fetch-depth 1), so without this the
 * local origin/main is pinned to the commit checked out at job start and the
 * whole fix would be a no-op.
 *
 * ⚠️ `--depth=1` IS ONLY SAFE ON AN ALREADY-SHALLOW CLONE. Passing it to a
 * fetch in a FULL clone truncates that clone's history to a single commit —
 * it writes a .git/shallow graft, and `git rev-list --count HEAD` drops to 1.
 * That is a destructive side effect on a maintainer's working repo, recovered
 * only by `git fetch --unshallow`. Measured, not theorised: an earlier draft
 * of this function did exactly that to the local clone on 2026-09-08. So the
 * depth flag is gated on isShallowRepo() and a full clone gets a plain fetch.
 *
 * The refspec is written out in full (`main:refs/remotes/origin/main`) rather
 * than relying on git's opportunistic tracking-ref update, so the ref this
 * guard then reads is guaranteed to be the one just fetched.
 *
 * Deliberately swallows failure: a dead network must not abort the guard, and
 * cannot weaken it either — an unfetched origin/main is at-or-behind current
 * origin/main, so the baseline stays a superset and the check stays stricter.
 * @returns {boolean} whether the fetch succeeded
 */
export function fetchBaselineRef(repoRoot, ref, exec = execFileSync) {
  const [remote, ...rest] = ref.split("/");
  const branch = rest.join("/");
  if (!remote || !branch) return false; // not a remote-tracking ref (e.g. "HEAD")
  const args = ["fetch"];
  if (isShallowRepo(repoRoot, exec)) args.push("--depth=1");
  args.push(remote, `${branch}:refs/remotes/${remote}/${branch}`);
  try {
    exec("git", args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the ref to diff against: the preferred one when it resolves, else the
 * conservative fallback. Never returns a ref that does not exist.
 * @returns {{ref: string, fellBack: boolean, fetched: boolean}}
 */
export function resolveBaselineRef(repoRoot, options = {}) {
  const {
    preferred = process.env.SITING_BASELINE_REF || PREFERRED_BASELINE_REF,
    fallback = FALLBACK_BASELINE_REF,
    noFetch = process.env.SITING_BASELINE_NO_FETCH === "1",
    exec = execFileSync,
  } = options;

  const fetched = noFetch ? false : fetchBaselineRef(repoRoot, preferred, exec);
  if (refExists(repoRoot, preferred, exec)) {
    return { ref: preferred, fellBack: false, fetched };
  }
  return { ref: fallback, fellBack: true, fetched };
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
  const { ref: baselineRef, fellBack, fetched } = resolveBaselineRef(REPO_ROOT);
  if (fellBack) {
    console.warn(
      `[check-siting-additive] WARNING: could not resolve ` +
        `${process.env.SITING_BASELINE_REF || PREFERRED_BASELINE_REF}; falling back to ` +
        `${baselineRef}. The check still runs and is STRICTER this way (an older ` +
        `baseline holds a superset of fields), but a coordinate correction merged ` +
        `during this build may show up as a false "dropped field".`,
    );
  } else if (!fetched) {
    console.warn(
      `[check-siting-additive] WARNING: fetch of ${baselineRef} failed; comparing ` +
        `against the locally-known (possibly stale) copy of that ref.`,
    );
  }

  const oldObj = readBaselineFromGit(REPO_ROOT, SITING_CONTEXT_REL_PATH, baselineRef);
  if (oldObj === null) {
    console.log(
      `[check-siting-additive] No baseline found at ${baselineRef}:${SITING_CONTEXT_REL_PATH} ` +
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

  console.log(`=== siting-context.json additive check (vs ${baselineRef}) ===`);
  console.log(`  added:   ${diff.added.length}`);
  console.log(`  removed: ${diff.removed.length}`);
  console.log(`  lost:    ${diff.lost.length}`);
  console.log(`  nulled:  ${diff.nulled.length}`);
  console.log(`  changed: ${diff.changed.length}  (allowed — refreshed values)`);

  if (!additive) {
    console.error(
      "\n[check-siting-additive] DATA LOSS DETECTED — the regenerated " +
        `siting-context.json would lose data present at ${baselineRef}.`,
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
