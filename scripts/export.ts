/**
 * Regenerates the published data/facilities.json CC-BY snapshot FROM Neon
 * Postgres. Mirror of scripts/seed.ts, in the opposite direction: seed.ts
 * goes file->DB, this goes DB->file, so edits made via the write API flow
 * back into the forkable JSON export.
 *
 * Alongside facilities.json, also writes a sibling facilities.meta.json with
 * lightweight dataset-versioning metadata (asOf/recordCount/schemaVersion/
 * sourceRelease) so downstream consumers of the CC-BY snapshot can detect
 * staleness or shape changes without diffing the full dataset.
 *
 * Run via: npm run db:export  (requires DATABASE_URL in .env.local)
 * Optional: --out=<path> to write somewhere other than data/facilities.json.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import { facilitiesTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { rowToFacility } from "../lib/db/serialize";

/** Bumped only when the Zod `facilitySchema` shape changes in a breaking way — mirrors the API's `X-API-Version`. */
const SCHEMA_VERSION = 1;

export interface ExportMeta {
  asOf: string;
  recordCount: number;
  schemaVersion: number;
  sourceRelease: string;
}

/**
 * Pure builder for the facilities.meta.json shape — kept separate from disk
 * I/O so it's testable without a DB or a package.json read (see export.test.ts).
 */
export function buildExportMeta(
  recordCount: number,
  sourceRelease: string,
  now: Date = new Date()
): ExportMeta {
  return {
    asOf: now.toISOString(),
    recordCount,
    schemaVersion: SCHEMA_VERSION,
    sourceRelease,
  };
}

function parseOutPath(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--out="));
  const rel = flag ? flag.slice("--out=".length) : path.join("data", "facilities.json");
  return path.resolve(process.cwd(), rel);
}

function readPackageVersion(): string {
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return pkg.version;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Configure it in .env.local (see .env.example) before exporting."
    );
    process.exit(1);
  }

  const db = getDb();
  const rows = await db.select().from(facilitiesTable);

  const facilities = rows
    .map(rowToFacility)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Re-validate the full array before writing — the published snapshot must
  // be schema-valid; this throws loudly on any invalid record, same as seed.ts.
  const validated = facilitiesSchema.parse(facilities);

  const outPath = parseOutPath();
  writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n", "utf-8");

  const meta = buildExportMeta(validated.length, readPackageVersion());
  const metaOutPath = path.join(path.dirname(outPath), "facilities.meta.json");
  writeFileSync(metaOutPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");

  console.log(`Exported ${validated.length} facilities to ${outPath}`);
  console.log(`Wrote export metadata to ${metaOutPath}`);
  process.exit(0);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// export.ts`), not when `buildExportMeta` is imported by the test suite —
// matches scripts/discovery/submit-candidates.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
