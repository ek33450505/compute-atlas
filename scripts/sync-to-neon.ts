/**
 * Publishes `data/facilities.json` to Neon — the maintainer's single write
 * path for reviewed data.
 *
 * ## Why this exists
 *
 * Neon is the source of truth; the site reads it live. But data waves edited
 * the FILE, so data reached prod as *git → build → deploy* and every
 * correction cost a Vercel build. Worse, the only bulk file→DB tool was
 * `db:seed`, which inserts new ids happily but needs `--force` to touch an
 * existing row — and `--force` writes NO `facility_history` (so `/activity`
 * goes blind) and busts NO cache tags (so scoped pages stay stale until
 * someone hand-runs a revalidate curl). A plain `db:seed` against a wave with
 * 44 adds and 51 corrections publishes the 44 and silently drops all 51.
 *
 * This script closes that gap: it applies adds AND updates, writes history
 * for every single change, and busts exactly the tags it touched. Data then
 * reaches prod without a build at all.
 *
 * `db:seed` is NOT retired — it remains the bootstrap tool for an empty
 * database. `db:sync` is the tool for a live one.
 *
 * ## The human gate
 *
 * The `pending`-submission queue still governs UNREVIEWED intake — the
 * discovery pipeline and the anonymous `POST /api/contribute`. It is not
 * relaxed. This CLI is the other path: a maintainer publishing data they have
 * already reviewed (in the admin portal or in-session) is themselves the human
 * gate, which is why `--apply` is explicit and `--dry-run` is the default.
 *
 * ## Safety properties
 *
 * 1. **Dry run by default.** Nothing is written without `--apply`.
 * 2. **Never deletes.** Ids in Neon but absent from the JSON are reported as
 *    orphans and left completely alone.
 * 3. **Fail-closed drift guard.** `data/facilities.meta.json`'s `asOf` is the
 *    JSON snapshot's basis — the moment it was last generated from Neon by
 *    `db:export`. Any Neon row whose `updatedAt` is newer than that basis has
 *    moved ahead of the JSON (someone approved on the admin portal), so
 *    overwriting it would clobber a prod approval. Those rows are refused
 *    unless `--force-over-drift`. If the basis can't be established at all,
 *    EVERY update is refused rather than assumed safe. The guard is also
 *    re-applied atomically in the UPDATE's own WHERE clause, so a row that
 *    changes between planning and writing is skipped rather than clobbered.
 * 4. **Revalidation is pre-flighted.** If tag-busting is configured wrong,
 *    the script refuses BEFORE writing — the one failure mode worse than not
 *    publishing is publishing to a DB whose pages never refresh.
 *
 * Run via: npm run db:sync                     (dry run — prints the plan)
 *          npm run db:sync -- --apply          (writes + busts tags)
 *          npm run db:sync -- --apply --force-over-drift
 *          npm run db:sync -- --apply --skip-revalidate
 *
 * Requires DATABASE_URL, plus API_ADMIN_TOKEN and API_BASE_URL when applying
 * (unless `--skip-revalidate`). Afterwards run `npm run db:export` so the JSON
 * is regenerated FROM Neon and `npm run check:drift` is clean.
 *
 * Uses relative imports throughout, matching the other scripts in this folder.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, lte } from "drizzle-orm";

import { facilitiesSchema, type Facility } from "../lib/schema";
import { facilitiesTable, facilityHistoryTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { docToRow } from "../lib/db/serialize";
import { computeDocDiff, type DiffEntry } from "../lib/doc-diff";
import { canonicalize, canonicalStringify, changedTopLevelKeys } from "../lib/canonical-json";
import { tagsForFacility, isValidCacheTag, MAX_TAGS_PER_REQUEST } from "../lib/cache-tags";

/**
 * `facility_history.source` for rows this tool writes — a new value alongside
 * `"admin-direct"` (app writes), `"db-seed"` (bootstrap inserts) and a raw
 * submission id (promoted submissions). Distinct so the audit trail says
 * which door a change came through.
 */
export const SYNC_HISTORY_SOURCE = "maintainer-sync";

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** The subset of a facilities row the planner needs. */
export interface NeonSnapshotRow {
  id: string;
  doc: Facility;
  updatedAt: Date;
}

export interface PlannedChange {
  id: string;
  action: "create" | "update";
  /** Top-level Facility keys that differ. Empty for a create. */
  changedKeys: string[];
  doc: Facility;
  /** The Neon doc being replaced. Absent for a create. */
  prevDoc?: Facility;
}

export interface BlockedChange {
  id: string;
  changedKeys: string[];
  neonUpdatedAt: Date;
  /**
   * `neon-newer` — the row was written after the JSON's basis.
   * `unknown-basis` — no basis could be established, so no row can be proven safe.
   */
  reason: "neon-newer" | "unknown-basis";
}

export interface SyncPlan {
  /** The JSON snapshot's basis timestamp, or null when it couldn't be established. */
  basis: Date | null;
  /** False when `--force-over-drift` disabled the guard. */
  guardEnforced: boolean;
  creates: PlannedChange[];
  updates: PlannedChange[];
  blocked: BlockedChange[];
  unchangedCount: number;
  /** Ids in Neon but absent from the JSON. Reported only — never written, never deleted. */
  orphans: string[];
  /** De-duplicated cache tags covering every planned change. */
  tags: string[];
}

/**
 * Pure diff of the JSON snapshot against a Neon snapshot. No I/O, so the
 * decision logic is testable without a database.
 *
 * `jsonFacilities` must already be parsed through `facilitySchema` so schema
 * defaults are materialized — otherwise a record that Neon stored WITH
 * defaults would look "changed" against a JSON record without them. This is
 * the same normalization `scripts/check-neon-drift.ts` applies, deliberately:
 * the two tools must agree on what "changed" means or the drift checker would
 * flag rows this tool considers identical, forever.
 */
export function planSync(
  jsonFacilities: Facility[],
  neonRows: NeonSnapshotRow[],
  options: { basis: Date | null; forceOverDrift?: boolean }
): SyncPlan {
  const guardEnforced = !options.forceOverDrift;
  const neonById = new Map(neonRows.map((row) => [row.id, row]));

  const creates: PlannedChange[] = [];
  const updates: PlannedChange[] = [];
  const blocked: BlockedChange[] = [];
  let unchangedCount = 0;

  const seen = new Set<string>();
  for (const doc of jsonFacilities) {
    if (seen.has(doc.id)) {
      // A splice-appended duplicate would otherwise let the last copy win
      // silently. The JSON is the artifact under review; refuse to publish it.
      throw new Error(`Duplicate facility id in the JSON snapshot: ${doc.id}`);
    }
    seen.add(doc.id);

    const row = neonById.get(doc.id);
    if (!row) {
      creates.push({ id: doc.id, action: "create", changedKeys: [], doc });
      continue;
    }

    if (canonicalStringify(row.doc) === canonicalStringify(doc)) {
      unchangedCount++;
      continue;
    }

    const changedKeys = changedTopLevelKeys(
      row.doc as unknown as Record<string, unknown>,
      doc as unknown as Record<string, unknown>
    );

    // Fail closed: with no basis, no row can be PROVEN not to have moved
    // ahead of the snapshot, so none is safe to overwrite.
    const reason: BlockedChange["reason"] | null =
      options.basis === null
        ? "unknown-basis"
        : row.updatedAt.getTime() > options.basis.getTime()
          ? "neon-newer"
          : null;

    if (reason && guardEnforced) {
      blocked.push({ id: doc.id, changedKeys, neonUpdatedAt: row.updatedAt, reason });
      continue;
    }

    updates.push({ id: doc.id, action: "update", changedKeys, doc, prevDoc: row.doc });
  }

  const orphans = neonRows
    .filter((row) => !seen.has(row.id))
    .map((row) => row.id)
    .sort();

  return {
    basis: options.basis,
    guardEnforced,
    creates,
    updates,
    blocked,
    unchangedCount,
    orphans,
    tags: tagsForChanges([...creates, ...updates]),
  };
}

/**
 * The de-duplicated tag set for a batch of changes, plus the global
 * `"facilities"` tag when the batch is non-empty.
 *
 * `tagsForFacility` deliberately omits `"facilities"`: a single write must
 * not nuke the ~900-page aggregate surface, which self-heals on its own 1h
 * ISR timer. A bulk sync inverts that argument — one extra tag, once, is far
 * cheaper than the 95 individual writes it stands in for, and without it the
 * homepage would keep quoting yesterday's facility count for up to an hour
 * after a publish.
 */
export function tagsForChanges(changes: PlannedChange[]): string[] {
  const tags = new Set<string>();
  for (const change of changes) {
    for (const tag of tagsForFacility(change.doc, change.prevDoc)) tags.add(tag);
  }
  if (tags.size > 0) tags.add("facilities");
  return [...tags];
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
  created: PlannedChange[];
  updated: PlannedChange[];
  /** Rows whose atomic drift predicate no longer matched at write time. */
  blockedAtApply: string[];
  failed: { id: string; error: string }[];
  /** Ids whose facility write succeeded but whose audit row did not. */
  historyFailures: string[];
}

/**
 * Executes a plan against Neon. Sequential by design: a burst of concurrent
 * writes over Neon's serverless HTTP driver is the same failure mode that
 * broke production builds on 2026-08-05, and ~100 records is a few tens of
 * seconds. Per-record failures are collected and reported rather than
 * aborting — a partial apply is re-runnable, since the next plan simply won't
 * include what already landed.
 *
 * Calls `getDb()` internally, matching `lib/facility-write.ts` and
 * `scripts/seed.ts`, so tests mock `../lib/db/client` rather than injecting.
 */
export async function applySync(
  plan: SyncPlan,
  options: { source?: string } = {}
): Promise<ApplyResult> {
  const db = getDb();
  const source = options.source ?? SYNC_HISTORY_SOURCE;

  const result: ApplyResult = {
    created: [],
    updated: [],
    blockedAtApply: [],
    failed: [],
    historyFailures: [],
  };

  for (const change of plan.creates) {
    try {
      // onConflictDoNothing + returning distinguishes a real insert from a row
      // that appeared between planning and writing; a phantom conflict is
      // reported, never silently counted as published.
      const inserted = await db
        .insert(facilitiesTable)
        .values(docToRow(change.doc))
        .onConflictDoNothing()
        .returning({ id: facilitiesTable.id });

      if (inserted.length === 0) {
        result.failed.push({
          id: change.id,
          error: "already present in Neon at write time (appeared after the plan was computed)",
        });
        continue;
      }

      result.created.push(change);
      if (!(await recordHistory(change.id, "create", canonicalDocDiff(null, change.doc), source))) {
        result.historyFailures.push(change.id);
      }
    } catch (err) {
      result.failed.push({ id: change.id, error: errorMessage(err) });
    }
  }

  for (const change of plan.updates) {
    try {
      // The drift guard again, this time evaluated by Postgres as part of the
      // write, so a row approved on the admin portal in the seconds between
      // planning and applying is skipped rather than clobbered.
      const guard =
        plan.guardEnforced && plan.basis
          ? and(eq(facilitiesTable.id, change.id), lte(facilitiesTable.updatedAt, plan.basis))
          : eq(facilitiesTable.id, change.id);

      const updated = await db
        .update(facilitiesTable)
        .set({ ...docToRow(change.doc), updatedAt: new Date() })
        .where(guard)
        .returning({ id: facilitiesTable.id });

      if (updated.length === 0) {
        result.blockedAtApply.push(change.id);
        continue;
      }

      result.updated.push(change);
      const diff = canonicalDocDiff(change.prevDoc ?? null, change.doc);
      if (!(await recordHistory(change.id, "update", diff, source))) {
        result.historyFailures.push(change.id);
      }
    } catch (err) {
      result.failed.push({ id: change.id, error: errorMessage(err) });
    }
  }

  return result;
}

/**
 * Inserts one audit row. Log-and-continue on failure, mirroring
 * `recordFacilityHistory` in `lib/facility-write.ts` — losing an audit row is
 * recoverable, failing a facility write because the audit table hiccuped is
 * worse. Unlike that helper this reports the failure to the caller, because a
 * silently missing history row is precisely the `db:seed --force` bug this
 * script exists to fix; the run exits non-zero so it can't pass unnoticed.
 */
async function recordHistory(
  facilityId: string,
  changeType: "create" | "update",
  diff: DiffEntry[],
  source: string
): Promise<boolean> {
  try {
    const db = getDb();
    await db.insert(facilityHistoryTable).values({ facilityId, changeType, diff, source });
    return true;
  } catch (err) {
    console.error("facility_history insert failed for %s (%s):", facilityId, changeType, err);
    return false;
  }
}

/**
 * `computeDocDiff` compares with a raw `JSON.stringify`, which is correct for
 * the app's own writes — there both sides originate from the same jsonb
 * ordering, so only real edits differ. It is wrong for this tool: `prevDoc`
 * comes back from Postgres in jsonb key order while `doc` carries the order it
 * was authored in, so untouched objects like `location` register as changed
 * and the audit row lists keys nobody edited (and stores two values that look
 * identical, since jsonb re-normalizes them on the way in).
 *
 * Canonicalizing both sides first makes the recorded diff list exactly the
 * keys the dry-run plan listed — what the maintainer reviewed is what the
 * audit trail says.
 */
function canonicalDocDiff(before: Facility | null, after: Facility): DiffEntry[] {
  return computeDocDiff(
    before ? (canonicalize(before) as Record<string, unknown>) : null,
    canonicalize(after) as Record<string, unknown>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Cache-tag busting
// ---------------------------------------------------------------------------

export interface BustTagsResult {
  batches: number;
  bustedTags: string[];
  failedTags: string[];
  errors: string[];
}

/**
 * Busts cache tags through `POST /api/revalidate`. A standalone tsx process
 * has no Next runtime and so cannot call `revalidateTag` itself — this route
 * exists for exactly this caller.
 *
 * Batched to `MAX_TAGS_PER_REQUEST`, and a failing batch does not strand the
 * rest: every failure is reported with its tags so the operator can retry
 * precisely.
 */
export async function bustTags(
  tags: string[],
  options: { baseUrl: string; token: string; fetchImpl?: typeof fetch }
): Promise<BustTagsResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const result: BustTagsResult = { batches: 0, bustedTags: [], failedTags: [], errors: [] };

  for (let i = 0; i < tags.length; i += MAX_TAGS_PER_REQUEST) {
    const batch = tags.slice(i, i + MAX_TAGS_PER_REQUEST);
    result.batches++;
    try {
      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/api/revalidate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: batch }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        result.failedTags.push(...batch);
        result.errors.push(`HTTP ${res.status} ${body}`.trim());
        continue;
      }

      result.bustedTags.push(...batch);
    } catch (err) {
      result.failedTags.push(...batch);
      result.errors.push(errorMessage(err));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Basis
// ---------------------------------------------------------------------------

export interface BasisResult {
  /** The guard basis: `asOf` minus the clock-skew margin. Null when it couldn't be established. */
  basis: Date | null;
  /** Human-readable provenance, printed in the report either way. */
  description: string;
}

/**
 * Safety margin subtracted from `asOf` before it is used as the drift-guard
 * basis.
 *
 * The two timestamps being compared come from different clocks:
 * `facilities.updatedAt` is stamped by Postgres (`defaultNow()`), while
 * `asOf` is stamped by whichever machine ran `db:export` — Ed's Mac or a
 * GitHub Actions runner. A few seconds of skew in the wrong direction would
 * let a genuine prod approval slip under the guard and be silently
 * overwritten. Backing the basis off makes the guard err toward blocking,
 * which is the failure it should prefer: a false block prints an explanation
 * and costs a `db:export`, a false pass discards someone's approval.
 */
export const BASIS_CLOCK_SKEW_MARGIN_MS = 5_000;

/**
 * Reads the JSON snapshot's basis from `data/facilities.meta.json` — the
 * `asOf` that `db:export` stamps when it generates the JSON FROM Neon. That
 * is precisely "the last moment JSON and Neon were known to agree", which is
 * what the drift guard needs to compare each row's `updatedAt` against.
 *
 * Returns `basis: null` (not a throw) on any problem, so the caller can fail
 * closed with an explanation rather than a stack trace.
 */
export function readBasis(metaPath: string): BasisResult {
  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf-8");
  } catch (err) {
    return { basis: null, description: `unreadable (${errorMessage(err)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { basis: null, description: `not valid JSON (${errorMessage(err)})` };
  }

  const asOf = (parsed as { asOf?: unknown } | null)?.asOf;
  if (typeof asOf !== "string") {
    return { basis: null, description: "no string `asOf` field" };
  }

  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) {
    return { basis: null, description: `\`asOf\` is not a valid date: ${asOf}` };
  }

  const basis = new Date(date.getTime() - BASIS_CLOCK_SKEW_MARGIN_MS);
  return {
    basis,
    description: `asOf ${date.toISOString()} → guard basis ${basis.toISOString()} (${BASIS_CLOCK_SKEW_MARGIN_MS / 1000}s clock-skew margin)`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * `forceOverDrift` is broader than its name suggests, deliberately noted here
 * because it is the destructive one: it disables the guard for BOTH blocked
 * reasons — `"neon-newer"` (we detected a row that moved ahead) and
 * `"unknown-basis"` (we could not establish a basis at all, so nothing can be
 * proven safe). Reaching for it because you have reviewed a specific drift
 * also opts you into overwriting blind if `facilities.meta.json` is missing or
 * malformed. `printPlan` states the guard is DISABLED before any write, and
 * dry run is still the default, so this cannot fire unnoticed.
 */
export interface CliOptions {
  apply: boolean;
  forceOverDrift: boolean;
  skipRevalidate: boolean;
}

const KNOWN_FLAGS = new Set(["--apply", "--dry-run", "--force-over-drift", "--skip-revalidate"]);

export function parseCliArgs(argv: string[]): CliOptions {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: ${[...KNOWN_FLAGS].join(", ")}`
    );
  }
  // `--dry-run` is accepted but redundant; it makes the default explicit at a
  // call site, and `--apply` always wins if someone passes both.
  return {
    apply: argv.includes("--apply"),
    forceOverDrift: argv.includes("--force-over-drift"),
    skipRevalidate: argv.includes("--skip-revalidate"),
  };
}

function describeChange(change: PlannedChange): string {
  const doc = change.doc;
  if (change.action === "create") {
    return `  + ${doc.id}  [${doc.facilityType}/${doc.location.state}/${doc.status}]`;
  }
  return `  ~ ${doc.id}  →  ${change.changedKeys.join(", ")}`;
}

function printPlan(plan: SyncPlan, jsonCount: number, neonCount: number, basisDesc: string): void {
  console.log(`JSON: ${jsonCount} facilities · Neon: ${neonCount} facilities`);
  console.log(`Basis (data/facilities.meta.json): ${basisDesc}`);
  console.log(
    `Drift guard: ${plan.guardEnforced ? "ENFORCED" : "DISABLED (--force-over-drift)"}\n`
  );

  console.log(`CREATE ${plan.creates.length}`);
  for (const change of plan.creates) console.log(describeChange(change));

  console.log(`\nUPDATE ${plan.updates.length}`);
  for (const change of plan.updates) console.log(describeChange(change));

  console.log(`\nUNCHANGED ${plan.unchangedCount}`);

  if (plan.blocked.length > 0) {
    console.log(`\n⚠ BLOCKED by the drift guard: ${plan.blocked.length}`);
    console.log("  These Neon rows moved ahead of the JSON snapshot. Overwriting them would");
    console.log("  discard a prod approval. Run `npm run db:export` to pull them into the JSON,");
    console.log("  reconcile by hand, then re-run — or pass --force-over-drift to overwrite.");
    for (const b of plan.blocked) {
      console.log(
        `  ! ${b.id}  (neon updatedAt ${b.neonUpdatedAt.toISOString()}, ${b.reason})  →  ${b.changedKeys.join(", ")}`
      );
    }
  }

  if (plan.orphans.length > 0) {
    console.log(`\nORPHANS in Neon, absent from the JSON: ${plan.orphans.length} (never touched)`);
    console.log("  Run `npm run db:export` to pull them into the JSON snapshot.");
    for (const id of plan.orphans) console.log(`  ? ${id}`);
  }

  const batches = Math.ceil(plan.tags.length / MAX_TAGS_PER_REQUEST);
  console.log(`\nCache tags to bust: ${plan.tags.length} (${batches} request(s))`);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before syncing."
    );
    process.exit(1);
  }

  const baseUrl = process.env.API_BASE_URL;
  const token = process.env.API_ADMIN_TOKEN;
  const willRevalidate = options.apply && !options.skipRevalidate;

  // Pre-flight BEFORE any write. Publishing rows whose pages can never be
  // busted is worse than not publishing: scoped pages (facility detail, state
  // landing) are tag-only with no ISR timer, so they would stay stale
  // indefinitely. Deliberately no localhost default for API_BASE_URL — that
  // would write prod Neon and bust a dev server's cache.
  if (willRevalidate && (!baseUrl || !token)) {
    console.error(
      "Refusing to apply: --apply busts cache tags over HTTP and needs both API_BASE_URL and " +
        "API_ADMIN_TOKEN in .env.local.\n" +
        `  API_BASE_URL: ${baseUrl ?? "(unset)"}\n` +
        `  API_ADMIN_TOKEN: ${token ? "(set)" : "(unset)"}\n` +
        "Set them, or pass --skip-revalidate to write without busting (pages stay stale)."
    );
    process.exit(1);
  }
  const revalidateConfig = willRevalidate && baseUrl && token ? { baseUrl, token } : null;

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const metaPath = path.join(path.dirname(jsonPath), "facilities.meta.json");

  const facilities = facilitiesSchema.parse(JSON.parse(readFileSync(jsonPath, "utf-8")));
  const { basis, description: basisDesc } = readBasis(metaPath);

  const db = getDb();
  const neonRows = await db
    .select({
      id: facilitiesTable.id,
      doc: facilitiesTable.doc,
      updatedAt: facilitiesTable.updatedAt,
    })
    .from(facilitiesTable);

  const plan = planSync(facilities, neonRows, {
    basis,
    forceOverDrift: options.forceOverDrift,
  });

  // A tag the revalidate route would reject aborts its whole batch — catch
  // that here, before anything is written, rather than after.
  const invalidTags = plan.tags.filter((tag) => !isValidCacheTag(tag));
  if (invalidTags.length > 0) {
    console.error(
      `Refusing to proceed: ${invalidTags.length} planned cache tag(s) are outside the allowlist ` +
        `in lib/cache-tags.ts and would be rejected by /api/revalidate:\n  ${invalidTags.join("\n  ")}`
    );
    process.exit(1);
  }

  printPlan(plan, facilities.length, neonRows.length, basisDesc);

  if (!options.apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to publish.");
    process.exit(0);
  }

  if (plan.creates.length === 0 && plan.updates.length === 0) {
    console.log("\nNothing to apply.");
    process.exit(plan.blocked.length > 0 ? 1 : 0);
  }

  console.log(
    `\nAPPLYING to Neon${revalidateConfig ? ` and busting tags at ${revalidateConfig.baseUrl}` : " (--skip-revalidate: NOT busting tags)"}…`
  );
  const result = await applySync(plan);
  console.log(`Created ${result.created.length}, updated ${result.updated.length}.`);

  let failed = plan.blocked.length > 0;

  if (result.blockedAtApply.length > 0) {
    failed = true;
    console.error(
      `\n⚠ ${result.blockedAtApply.length} row(s) changed in Neon between planning and writing, ` +
        `and were skipped by the atomic drift guard:\n  ${result.blockedAtApply.join("\n  ")}`
    );
  }
  if (result.failed.length > 0) {
    failed = true;
    console.error(`\n⚠ ${result.failed.length} record(s) failed:`);
    for (const f of result.failed) console.error(`  ! ${f.id}: ${f.error}`);
  }
  if (result.historyFailures.length > 0) {
    failed = true;
    console.error(
      `\n⚠ ${result.historyFailures.length} facility write(s) landed without an audit row ` +
        `(they will be missing from /activity):\n  ${result.historyFailures.join("\n  ")}`
    );
  }

  const appliedTags = tagsForChanges([...result.created, ...result.updated]);
  if (revalidateConfig && appliedTags.length > 0) {
    const bust = await bustTags(appliedTags, revalidateConfig);
    console.log(`\nBusted ${bust.bustedTags.length} tag(s) in ${bust.batches} request(s).`);
    if (bust.failedTags.length > 0) {
      failed = true;
      console.error(`⚠ ${bust.failedTags.length} tag(s) failed to bust: ${bust.errors.join("; ")}`);
      console.error(
        "Retry them with:\n  curl -X POST \"$API_BASE_URL/api/revalidate\" " +
          '-H "Authorization: Bearer $API_ADMIN_TOKEN" -H "Content-Type: application/json" \\\n' +
          `    -d '${JSON.stringify({ tags: bust.failedTags.slice(0, MAX_TAGS_PER_REQUEST) })}'`
      );
    }
  } else if (!revalidateConfig) {
    console.log(
      `\nSkipped busting ${appliedTags.length} tag(s). Scoped pages (facility detail, state ` +
        "landing) have no ISR timer and will stay stale until something busts them."
    );
  }

  console.log("\nNext: `npm run db:export` to regenerate the JSON from Neon, then commit it.");
  process.exit(failed ? 1 : 0);
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/seed.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
