/**
 * Backfill data/siting-context.json into the Neon `siting_context` table.
 * DRY RUN IS THE DEFAULT and needs no DATABASE_URL (it reports "would upsert N").
 *
 *   npm run backfill:siting              dry run
 *   npm run backfill:siting -- --apply   idempotent upsert, then read back and verify
 *
 * One-time bootstrap: only MISSING rows are inserted. --apply refuses, before
 * writing anything, if an existing row differs from the JSON ("Neon has moved
 * ahead of the committed JSON"); there is no force flag. A re-run is a no-op.
 * It also refuses (non-zero exit) if the table's row count after the write
 * differs from the source count, or any row fails to deep-equal its source.
 * Reads the file with fs, never through `@/data` (Vitest aliases that to a fixture).
 *
 * Uses relative imports, matching the other scripts here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatReport,
  RefusalError,
  sitingStore,
  syncKeyed,
  type KeyedStore,
} from "../lib/closed-data-store";
import { formatFatalError } from "../lib/db-error";
import { hasDatabaseUrl } from "../lib/db/client";
import { isEntrypoint } from "./is-entrypoint";

export interface Deps {
  root: string;
  readFile: (file: string) => string;
  /** null = no database available (dry run only). */
  store: () => KeyedStore | null;
  log: (line: string) => void;
}

export function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { apply };
}

export function loadSource(deps: Pick<Deps, "root" | "readFile">): Map<string, unknown> {
  const raw: unknown = JSON.parse(deps.readFile(path.join(deps.root, "data/siting-context.json")));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RefusalError("data/siting-context.json is not a JSON object keyed by facility id");
  }
  return new Map(Object.entries(raw));
}

export async function run(argv: string[], deps: Deps): Promise<void> {
  const { apply } = parseArgs(argv);
  const source = loadSource(deps);
  const report = await syncKeyed({ source, store: deps.store(), apply, label: "siting_context" });
  deps.log(formatReport("siting_context", report));
}

if (isEntrypoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  run(process.argv.slice(2), {
    root,
    readFile: (f) => readFileSync(f, "utf8"),
    store: () => (hasDatabaseUrl() ? sitingStore() : null),
    log: (l) => console.log(l),
  }).catch((err) => {
    if (err instanceof RefusalError) {
      // lint-no-raw-error-logs: allow -- RefusalError (lib/closed-data-store.ts) is built only from ids and counts in this tooling, never from a caught DB error
      console.error(err.message);
    } else {
      console.error(formatFatalError(err));
    }
    process.exit(1);
  });
}
