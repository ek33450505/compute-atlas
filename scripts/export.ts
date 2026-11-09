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

import {
  DEFAULT_FLOORS,
  buildSnapshotBodies,
  neonSource,
  type SnapshotFloors,
  type SnapshotSource,
} from "../lib/dataset-snapshot";
import { isEntrypoint } from "./is-entrypoint";
import { formatFatalError } from "../lib/db-error";

// The snapshot builder lives in lib/ so the edition cron route can use it without importing from
// scripts/. Re-exported so every existing importer of this module compiles unchanged.
export {
  MIN_FACILITIES,
  MIN_OWNERSHIP_ROWS,
  MIN_SITING_ROWS,
  buildExportMeta,
  type ExportMeta,
  type SnapshotSource,
} from "../lib/dataset-snapshot";

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

export interface SnapshotOptions {
  /** Directory the four files are written into. Default: <cwd>/data. */
  dir?: string;
  /** Default: the Neon tables. Injected by tests. */
  source?: SnapshotSource;
  warn?: (msg: string) => void;
  /** Override the floors (tests with small fixtures only). */
  floors?: SnapshotFloors;
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
  const floors = opts.floors ?? DEFAULT_FLOORS;

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
  const { bodies: outputs, facilities, missingSiting, orphanSiting } = await buildSnapshotBodies(source, {
    floors,
    readAt,
    warn,
  });
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
