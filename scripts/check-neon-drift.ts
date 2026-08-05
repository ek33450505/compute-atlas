/**
 * Read-only JSON↔Neon drift detector. Reports THREE drift classes:
 *   - MISSING: in Neon, absent from JSON (net-new prod approvals)
 *   - CHANGED: in BOTH but content differs (edited on prod)
 *   - JSON_ONLY: in JSON, absent from Neon
 *
 * "Changed" uses an ORDER-INSENSITIVE canonical compare (recursively sorts
 * object keys) so pure key-order / serialization churn is NOT flagged — only
 * real value differences are.
 *
 * Non-blocking: prints GitHub Actions warnings and always exits 0 (never fails CI).
 * If DATABASE_URL is unset, prints a notice and exits 0 gracefully.
 *
 * Run: npm run check:drift (local, reads .env.local)
 * Or:  npx tsx scripts/check-neon-drift.ts (CI, reads DATABASE_URL from env)
 *
 * Uses relative imports — tsx does not resolve the `@/*` path alias.
 */
import { readFileSync } from "node:fs";
import { facilitiesTable } from "../lib/db/schema";
import { getDb } from "../lib/db/client";
import { rowToFacility } from "../lib/db/serialize";
import { facilitySchema, type Facility } from "../lib/schema";

function canon(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const obj = x as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce((o: Record<string, unknown>, k) => ((o[k] = canon(obj[k])), o), {});
  }
  return x;
}

const canonStr = (x: unknown) => JSON.stringify(canon(x));

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff: string[] = [];
  for (const k of keys) if (canonStr(a[k]) !== canonStr(b[k])) diff.push(k);
  return diff.sort();
}

async function main() {
  // Graceful no-op if DATABASE_URL not configured
  if (!process.env.DATABASE_URL) {
    console.log("::notice::DATABASE_URL not configured — skipping drift check");
    process.exit(0);
  }

  try {
    const json = JSON.parse(
      readFileSync("data/facilities.json", "utf8")
    ) as Facility[];

    // Parse each JSON record through facilitySchema so schema DEFAULTS are
    // materialized the same way Neon materialized them at write time.
    const jsonById = new Map(
      json.map((f) => [f.id, facilitySchema.parse(f)])
    );

    const db = getDb();
    const rows = await db.select().from(facilitiesTable);
    const neon = rows.map(rowToFacility);
    const neonById = new Map(neon.map((f) => [f.id, f]));

    const missing = neon.filter((f) => !jsonById.has(f.id));
    const jsonOnly = json.filter((f) => !neonById.has(f.id)).map((f) => f.id);
    const changed: { id: string; keys: string[] }[] = [];

    for (const f of neon) {
      const j = jsonById.get(f.id);
      if (j && canonStr(j) !== canonStr(f)) {
        changed.push({
          id: f.id,
          keys: changedKeys(
            j as unknown as Record<string, unknown>,
            f as unknown as Record<string, unknown>,
          ),
        });
      }
    }

    console.log(`Neon: ${neon.length} facilities, JSON: ${json.length} facilities`);

    if (missing.length > 0 || changed.length > 0 || jsonOnly.length > 0) {
      console.log(
        `::warning::JSON↔Neon drift: ${missing.length} new, ${changed.length} changed, ${jsonOnly.length} json-only. Run \`npm run db:export\` to sync.`
      );

      if (missing.length > 0) {
        console.log(`\nMISSING (in Neon, not JSON): ${missing.length}`);
        for (const f of missing) {
          console.log(
            `   + ${f.id}  [${f.facilityType}/${f.location.state}/${f.status}]`
          );
        }
      }

      if (changed.length > 0) {
        console.log(`\nCHANGED (edited on prod): ${changed.length}`);
        for (const c of changed) {
          console.log(`   ~ ${c.id}  →  fields: ${c.keys.join(", ")}`);
        }
      }

      if (jsonOnly.length > 0) {
        console.log(`\nJSON_ONLY (in JSON, not Neon): ${jsonOnly.length}`);
        console.log(`   ${JSON.stringify(jsonOnly)}`);
      }
    } else {
      console.log("✓ No drift detected between JSON and Neon");
    }
  } catch (err) {
    // Log only the message (not the raw error object) so a Neon/pg connection
    // error can't echo the DB host/DSN into this public repo's Actions logs.
    console.error(
      "::notice::drift check errored (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
    // Still non-blocking — exit 0 so CI doesn't fail
    process.exit(0);
  }

  process.exit(0);
}

main();
