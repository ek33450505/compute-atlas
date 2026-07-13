/**
 * Regenerates the published data/facilities.json CC-BY snapshot FROM Neon
 * Postgres. Mirror of scripts/seed.ts, in the opposite direction: seed.ts
 * goes file->DB, this goes DB->file, so edits made via the write API flow
 * back into the forkable JSON export.
 *
 * Run via: npm run db:export  (requires DATABASE_URL in .env.local)
 * Optional: --out=<path> to write somewhere other than data/facilities.json.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { facilitiesSchema } from "../lib/schema";
import { facilitiesTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { rowToFacility } from "../lib/db/serialize";

function parseOutPath(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--out="));
  const rel = flag ? flag.slice("--out=".length) : path.join("data", "facilities.json");
  return path.resolve(process.cwd(), rel);
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

  console.log(`Exported ${validated.length} facilities to ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
