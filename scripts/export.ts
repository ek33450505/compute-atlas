/**
 * Regenerates the published data/facilities.json CC-BY snapshot FROM Neon
 * Postgres. Mirror of scripts/seed.ts, in the opposite direction: seed.ts
 * goes file->DB, this goes DB->file, so edits made via the write API flow
 * back into the forkable JSON export.
 *
 * Alongside facilities.json, also writes a sibling facilities.meta.json with
 * lightweight dataset-versioning metadata (asOf/recordCount/schemaVersion) so
 * downstream consumers of the CC-BY snapshot can detect staleness or shape
 * changes without diffing the full dataset.
 *
 * Run via: npm run db:export  (requires DATABASE_URL in .env.local)
 * Optional: --out=<path> to write somewhere other than data/facilities.json.
 *
 * Uses relative imports throughout, matching the other scripts in this folder.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import { facilitiesTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { rowToFacility } from "../lib/db/serialize";
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

function parseOutPath(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--out="));
  const rel = flag ? flag.slice("--out=".length) : path.join("data", "facilities.json");
  return path.resolve(process.cwd(), rel);
}

const MISSING_DATABASE_URL =
  "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before exporting.";

/** Thrown (by name, so callers need not import this module) when DATABASE_URL is unset. */
export class MissingDatabaseUrlError extends Error {
  override name = "MissingDatabaseUrlError";
}

export interface ExportResult {
  count: number;
  outPath: string;
  metaOutPath: string;
}

/**
 * Reads every facility from Neon and writes facilities.json plus its sibling
 * facilities.meta.json. Callable (rather than inlined in `main`) so
 * scripts/ensure-data-snapshot.ts can reuse it. Throws instead of exiting.
 */
export async function exportFacilities(
  outPath: string = path.resolve(process.cwd(), path.join("data", "facilities.json"))
): Promise<ExportResult> {
  if (!process.env.DATABASE_URL) {
    throw new MissingDatabaseUrlError(MISSING_DATABASE_URL);
  }

  const db = getDb();

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
  const rows = await db.select().from(facilitiesTable);

  const facilities = rows
    .map(rowToFacility)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Re-validate the full array before writing — the published snapshot must
  // be schema-valid; this throws loudly on any invalid record, same as seed.ts.
  const validated = facilitiesSchema.parse(facilities);

  const meta = buildExportMeta(validated.length, readAt);
  const metaOutPath = path.join(path.dirname(outPath), "facilities.meta.json");

  // Write both files to temp paths, then rename both. This narrows the window
  // (a failed write never touches the real files), but it is not atomic: a
  // failure on the second rename can still leave a new facilities.json next to
  // an old meta. No rollback is attempted.
  const tmpSuffix = `.tmp-${process.pid}`;
  const tmpOut = outPath + tmpSuffix;
  const tmpMeta = metaOutPath + tmpSuffix;
  try {
    writeFileSync(tmpOut, JSON.stringify(validated, null, 2) + "\n", "utf-8");
    writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    renameSync(tmpOut, outPath);
    renameSync(tmpMeta, metaOutPath);
  } finally {
    rmSync(tmpOut, { force: true });
    rmSync(tmpMeta, { force: true });
  }

  return { count: validated.length, outPath, metaOutPath };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(MISSING_DATABASE_URL);
    process.exit(1);
  }

  const { count, outPath, metaOutPath } = await exportFacilities(parseOutPath());

  console.log(`Exported ${count} facilities to ${outPath}`);
  console.log(`Wrote export metadata to ${metaOutPath}`);
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
