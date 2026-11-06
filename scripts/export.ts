/**
 * Regenerates the data/ snapshot files FROM Neon Postgres: facilities.json,
 * facilities.meta.json (asOf/recordCount/schemaVersion), siting-context.json and
 * operator-ownership.json. Mirror of scripts/seed.ts, in the opposite
 * direction: seed.ts goes file->DB, this goes DB->file.
 *
 * Run via: npm run db:export  (requires DATABASE_URL in .env.local)
 * Optional: --dir=<path> to write into a subdirectory of data/ instead of data/.
 *
 * Uses relative imports throughout, matching the other scripts in this folder.
 */
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import { facilitiesTable, operatorOwnershipTable, sitingContextTable, type FacilityRow } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { rowToFacility } from "../lib/db/serialize";
import { byOperator, operatorOwnershipFileSchema } from "../lib/operator-ownership";
import { sitingContextSchema } from "../lib/siting-context";
import { isEntrypoint } from "./is-entrypoint";
import { formatFatalError } from "../lib/db-error";

/** Bumped only when the Zod `facilitySchema` shape changes in a breaking way — mirrors the API's `X-API-Version`. */
const SCHEMA_VERSION = 1;

export interface ExportMeta {
  asOf: string;
  recordCount: number;
  schemaVersion: number;
}

/**
 * Pure builder for the facilities.meta.json shape — kept separate from disk
 * I/O so it's testable without a DB or a package.json read (see export.test.ts).
 *
 * `now` should be the instant the DB read STARTED, not when the file was
 * written — see the comment at its call site in `main()`. The default exists
 * for tests and ad-hoc use; the CLI always passes an explicit value.
 */
export function buildExportMeta(
  recordCount: number,
  now: Date = new Date()
): ExportMeta {
  return {
    asOf: now.toISOString(),
    recordCount,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Output directory from `--dir=<path>` (default <cwd>/data). Must be `data/` or
 * a path inside it: the repo root and other folders are not gitignored, so a
 * snapshot written there could be committed. Tests that need a temp dir pass it
 * through `exportSnapshot({ dir })`, not the CLI. The legacy `--out` is rejected
 * so a stale caller fails loudly.
 */
export function parseDirArg(argv: string[], cwd: string = process.cwd()): string {
  if (argv.some((arg) => arg === "--out" || arg.startsWith("--out="))) {
    throw new Error("--out is no longer supported; use --dir=<directory>");
  }
  if (argv.includes("--dir")) {
    throw new Error("use --dir=<path> (the space-separated form is not supported)");
  }
  const flag = argv.find((arg) => arg.startsWith("--dir="));
  const value = flag ? flag.slice("--dir=".length) : "data";
  if (value.trim() === "") {
    throw new Error("--dir= needs a path, e.g. --dir=data/sub");
  }
  const dataDir = path.resolve(cwd, "data");
  const dir = path.resolve(cwd, value);
  const rel = path.relative(dataDir, dir);
  const escapes = (r: string) => r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
  if (escapes(rel)) {
    throw new Error(`--dir must be data/ or a path inside it (${dataDir}); got ${dir}`);
  }
  // Symlink check, here so the CLI path is covered before exportSnapshot's mkdir
  // follows a symlinked ancestor out of data/.
  const realData = realpathOfDeepestExisting(dataDir);
  const realDir = realpathOfDeepestExisting(dir);
  if (realData === null || realDir === null || escapes(path.relative(realData, realDir))) {
    throw new Error(`--dir must be data/ or a path inside it (${dataDir}); got ${dir} (resolves outside via a symlink)`);
  }
  return dir;
}

/**
 * realpath of the deepest ancestor of `p` that exists, with the not-yet-created tail re-appended.
 * lstat, not existsSync: a dangling symlink counts as existing. Returns null when that ancestor
 * cannot be resolved (a dangling link) or lstat fails for any reason but ENOENT; the caller refuses.
 */
function realpathOfDeepestExisting(p: string): string | null {
  let existing = p;
  while (path.dirname(existing) !== existing) {
    try {
      lstatSync(existing);
      break;
    } catch (err) {
      // Only "not there yet" climbs; any other error (ENOTDIR, EACCES, ELOOP) fails closed.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      existing = path.dirname(existing);
    }
  }
  try {
    return path.join(realpathSync(existing), path.relative(existing, p));
  } catch {
    return null;
  }
}

const MISSING_DATABASE_URL =
  "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before exporting.";

/** Thrown (by name, so callers need not import this module) when DATABASE_URL is unset. */
export class MissingDatabaseUrlError extends Error {
  override name = "MissingDatabaseUrlError";
}

/**
 * Row-count floors: a read below one means a truncated, stale or wrong-branch
 * read, and a snapshot built from it must never replace the real files. Set
 * against what Neon held on 2026-11-06 (3,025 facilities, 3,025 siting rows,
 * 26 ownership rows): 2900 is about 96% of 3,025, 24 is about 92% of 26. That
 * catches a stale or branch-scoped DATABASE_URL.
 * Raise these as the dataset grows; a legitimate shrink below them needs a
 * deliberate edit here.
 */
export const MIN_FACILITIES = 2900;
export const MIN_SITING_ROWS = 2900;
export const MIN_OWNERSHIP_ROWS = 24;

export interface SnapshotSource {
  facilities(): Promise<Array<Pick<FacilityRow, "doc">>>;
  sitingContext(): Promise<Array<{ facilityId: string; data: unknown }>>;
  operatorOwnership(): Promise<Array<{ data: unknown }>>;
}

export interface SnapshotOptions {
  /** Directory the four files are written into. Default: <cwd>/data. */
  dir?: string;
  /** Default: the Neon tables. Injected by tests. */
  source?: SnapshotSource;
  warn?: (msg: string) => void;
  /** Override the floors (tests with small fixtures only). */
  floors?: { facilities: number; siting: number; ownership: number };
}

function neonSource(): SnapshotSource {
  const db = getDb();
  return {
    facilities: () => db.select().from(facilitiesTable),
    sitingContext: () =>
      db.select({ facilityId: sitingContextTable.facilityId, data: sitingContextTable.data }).from(sitingContextTable),
    operatorOwnership: () => db.select({ data: operatorOwnershipTable.data }).from(operatorOwnershipTable),
  };
}

export interface ExportResult {
  count: number;
  dir: string;
  files: string[];
  /** Facilities with no siting_context row. Reported, never fatal: new records lack siting until a local refresh. */
  missingSiting: number;
  /** siting_context rows whose facility_id is not in facilities. Reported, still exported. */
  orphanSiting: number;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** A JSON null on a siting field means absent (same rule as lib/siting-context.ts withoutNulls). */
const dropNulls = (entry: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null));

/**
 * Reads facilities, siting_context and operator_ownership from Neon and writes
 * facilities.json, facilities.meta.json, siting-context.json and
 * operator-ownership.json. Callable (rather than inlined in `main`) so
 * scripts/ensure-data-snapshot.ts can reuse it. Throws instead of exiting.
 *
 * Everything is read, floor-checked and validated BEFORE any file is touched,
 * then all four are written to temp paths and renamed together. A failure
 * before the renames leaves the existing files byte-identical. The renames
 * themselves are not transactional: a failure partway through them (disk
 * error) can leave a mixed set; no rollback is attempted. On a Vercel PREVIEW
 * build that could ship a mixed set; this is accepted, because production fails
 * closed on any export failure and all four renames target the same directory.
 */
export async function exportSnapshot(opts: SnapshotOptions = {}): Promise<ExportResult> {
  if (!opts.source && !process.env.DATABASE_URL) {
    throw new MissingDatabaseUrlError(MISSING_DATABASE_URL);
  }
  const dir = opts.dir ?? path.resolve(process.cwd(), "data");
  const source = opts.source ?? neonSource();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const floors = opts.floors ?? { facilities: MIN_FACILITIES, siting: MIN_SITING_ROWS, ownership: MIN_OWNERSHIP_ROWS };

  // Stamped BEFORE the read, deliberately. `asOf` is not decoration: it is the
  // basis `scripts/sync-to-neon.ts` compares each Neon row's `updatedAt`
  // against to decide whether that row has moved ahead of this snapshot and
  // must not be overwritten.
  //
  // Stamping it after the read (as this used to) opened a window: a row edited
  // between the SELECT's MVCC snapshot and the timestamp is absent from the
  // exported JSON, yet carries `updatedAt < asOf` — so a later sync would read
  // it as safely overwritable and silently revert it. Exactly the clobber the
  // guard exists to prevent.
  //
  // Taking the timestamp first makes the basis conservative BY CONSTRUCTION:
  // anything written after this instant sorts newer than the basis and gets
  // blocked. Erring early costs at most a spurious block (which prints an
  // explanation and is cleared by re-running `db:export`); erring late costs
  // someone's approval.
  const readAt = new Date();
  const [facilityRows, sitingRows, ownershipRows] = await Promise.all([
    source.facilities(),
    source.sitingContext(),
    source.operatorOwnership(),
  ]);

  if (facilityRows.length < floors.facilities) {
    throw new Error(`export refused: ${facilityRows.length} facilities is below the floor of ${floors.facilities}`);
  }
  if (sitingRows.length < floors.siting) {
    throw new Error(`export refused: ${sitingRows.length} siting_context rows is below the floor of ${floors.siting}`);
  }
  if (ownershipRows.length < floors.ownership) {
    throw new Error(`export refused: ${ownershipRows.length} operator_ownership rows is below the floor of ${floors.ownership}`);
  }

  // Re-validate everything before writing — the published snapshot must be
  // schema-valid; this throws loudly on any invalid record, same as seed.ts.
  const facilities = facilitiesSchema.parse(
    facilityRows.map(rowToFacility).sort((a, b) => a.id.localeCompare(b.id))
  );

  // Keyed by facility_id in code-unit order, the committed file's order.
  const siting: Record<string, unknown> = {};
  for (const row of [...sitingRows].sort((a, b) => (a.facilityId < b.facilityId ? -1 : a.facilityId > b.facilityId ? 1 : 0))) {
    siting[row.facilityId] = dropNulls(sitingContextSchema.parse(row.data));
  }

  // The committed file's order is hand-curated and Neon stores none, so rows
  // are written in operator-name code-unit order (deterministic).
  const ownership = operatorOwnershipFileSchema.parse(ownershipRows.map((r) => r.data)).sort(byOperator);

  const missingSiting = facilities.filter((f) => !Object.hasOwn(siting, f.id)).length;
  if (missingSiting > 0) {
    warn(`export: ${missingSiting} facilities have no siting_context row (expected until a local siting refresh)`);
  }

  const facilityIds = new Set(facilities.map((f) => f.id));
  const orphanSiting = Object.keys(siting).filter((id) => !facilityIds.has(id)).length;
  if (orphanSiting > 0) {
    warn(`export: ${orphanSiting} siting_context rows have no matching facility (exported anyway)`);
  }

  const outputs: Array<[string, string]> = [
    ["facilities.json", json(facilities)],
    ["facilities.meta.json", json(buildExportMeta(facilities.length, readAt))],
    ["siting-context.json", json(siting)],
    ["operator-ownership.json", json(ownership)],
  ];
  const files = outputs.map(([name]) => path.join(dir, name));
  const tmps = files.map((f) => `${f}.tmp-${process.pid}`);
  // `dir` already passed parseDirArg's confinement; creating it only now means a refused export makes nothing.
  mkdirSync(dir, { recursive: true });
  try {
    outputs.forEach(([, body], i) => writeFileSync(tmps[i], body, "utf-8"));
    tmps.forEach((tmp, i) => renameSync(tmp, files[i]));
  } finally {
    // Each cleanup is isolated: a failure here must neither mask the original
    // error nor skip the remaining temps.
    for (const tmp of tmps) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
    }
  }

  return { count: facilities.length, dir, files, missingSiting, orphanSiting };
}

async function main() {
  // Parsed first so an invalid --dir is refused even when DATABASE_URL is unset.
  const dir = parseDirArg(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error(MISSING_DATABASE_URL);
    process.exit(1);
  }

  const { count, files } = await exportSnapshot({ dir });

  console.log(`Exported ${count} facilities`);
  for (const f of files) console.log(`Wrote ${f}`);
  process.exit(0);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// export.ts`), not when `buildExportMeta` is imported by the test suite —
// matches scripts/discovery/submit-candidates.ts's isMain guard.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(formatFatalError(err));
    process.exit(1);
  });
}
