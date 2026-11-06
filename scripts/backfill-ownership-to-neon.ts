/**
 * Backfill data/operator-ownership.json into the Neon `operator_ownership` table.
 * DRY RUN IS THE DEFAULT and needs no DATABASE_URL (it reports "would upsert N").
 *
 *   npm run backfill:ownership              dry run
 *   npm run backfill:ownership -- --apply   idempotent upsert, then read back and verify
 *
 * The row key is the EXACT `operator` string, the same key lib/operator-ownership.ts
 * matches on (`ownersFor`); the stored value is the whole `{operator, owners}` entry.
 * --apply refuses (non-zero exit) if the row count after the write differs from the
 * source count, or any row fails to deep-equal its source. Reads the file with fs,
 * never through `@/data` (Vitest aliases that to a fixture).
 *
 * Uses relative imports, matching the other scripts here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatReport,
  ownershipStore,
  RefusalError,
  syncKeyed,
} from "../lib/closed-data-store";
import { formatFatalError } from "../lib/db-error";
import { hasDatabaseUrl } from "../lib/db/client";
import { isEntrypoint } from "./is-entrypoint";
import { parseArgs, type Deps } from "./backfill-siting-to-neon";

export function loadSource(deps: Pick<Deps, "root" | "readFile">): Map<string, unknown> {
  const raw: unknown = JSON.parse(deps.readFile(path.join(deps.root, "data/operator-ownership.json")));
  if (!Array.isArray(raw)) {
    throw new RefusalError("data/operator-ownership.json is not a JSON array");
  }
  const source = new Map<string, unknown>();
  for (const entry of raw) {
    const operator = (entry as { operator?: unknown } | null)?.operator;
    if (typeof operator !== "string" || operator === "") {
      throw new RefusalError("data/operator-ownership.json has an entry without an operator string");
    }
    if (source.has(operator)) {
      throw new RefusalError(`data/operator-ownership.json lists operator twice: ${operator}`);
    }
    source.set(operator, entry);
  }
  return source;
}

export async function run(argv: string[], deps: Deps): Promise<void> {
  const { apply } = parseArgs(argv);
  const source = loadSource(deps);
  const report = await syncKeyed({ source, store: deps.store(), apply, label: "operator_ownership" });
  deps.log(formatReport("operator_ownership", report));
}

if (isEntrypoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  run(process.argv.slice(2), {
    root,
    readFile: (f) => readFileSync(f, "utf8"),
    store: () => (hasDatabaseUrl() ? ownershipStore() : null),
    log: (l) => console.log(l),
  }).catch((err) => {
    console.error(err instanceof RefusalError ? err.message : formatFatalError(err));
    process.exit(1);
  });
}
