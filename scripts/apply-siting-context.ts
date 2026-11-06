/**
 * Publish a regenerated siting context to Neon.
 * DRY RUN IS THE DEFAULT.
 *
 *   npm run siting:apply              dry run: print the plan
 *   npm run siting:apply -- --apply   write the added/changed entries
 *
 * Reads data/siting-context.next.json (gitignored via `*.next.json`) and the
 * current `siting_context` rows, and runs the SAME additive rule as
 * scripts/check-siting-additive.mjs (`diffSitingContext` / `isAdditive`): no
 * dropped id, no lost field, no value -> null. If anything fails the rule the
 * WHOLE write is refused BEFORE any write. What gets written is every id whose
 * canonical value differs from the stored row (so a new field on an existing id
 * is written too); the diff is only the refusal gate.
 * An id absent from data/facilities.json counts as a retired orphan (`pruned`),
 * exactly as in the check. Nothing is ever deleted from Neon by this script.
 *
 * NOTE: nothing produces siting-context.next.json yet. A later PR makes
 * `build:mapdata` emit it (from "PR B" onward); until then the file is absent
 * and this script exits 1 saying so.
 *
 * The write is one transaction on the Neon driver (see `neonStoreFor`). Verify
 * runs AFTER it commits: it re-reads the table and exits non-zero unless every
 * written row deep-equals the next file's entry, but it cannot undo the write.
 *
 * Known limit: changed ids use an unguarded ON CONFLICT DO UPDATE (no
 * compare-and-set), so a concurrent writer to the same row would be overwritten.
 * Acceptable for a sole-maintainer local command; new ids use DO NOTHING.
 *
 * Uses relative imports, matching the other scripts here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  RefusalError,
  sitingStore,
  verifyRows,
  type KeyedRow,
  type KeyedStore,
} from "../lib/closed-data-store";
import { formatFatalError } from "../lib/db-error";
import { hasDatabaseUrl } from "../lib/db/client";
import { isEntrypoint } from "./is-entrypoint";
import { parseArgs, type Deps } from "./backfill-siting-to-neon";
import { diffSitingContext, isAdditive } from "./check-siting-additive.mjs";

type Entries = Record<string, Record<string, unknown>>;

const PRINT_LIMIT = 10;

function readObject(deps: Pick<Deps, "readFile">, file: string): Entries {
  let text: string;
  try {
    text = deps.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      throw new RefusalError("no siting-context.next.json; build:mapdata emits it from PR B onward");
    }
    throw err;
  }
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RefusalError(`${file} is not a JSON object keyed by facility id`);
  }
  return raw as Entries;
}

export async function run(
  argv: string[],
  deps: Omit<Deps, "store"> & { store: () => KeyedStore },
): Promise<void> {
  const { apply } = parseArgs(argv);
  const next = readObject(deps, path.join(deps.root, "data/siting-context.next.json"));
  const facilities: unknown = JSON.parse(deps.readFile(path.join(deps.root, "data/facilities.json")));
  if (!Array.isArray(facilities) || facilities.length === 0) {
    // An empty list would make every dropped id look like a prune.
    throw new RefusalError("data/facilities.json is unreadable or empty; cannot classify dropped ids");
  }
  const liveIds = new Set<string>(facilities.map((f: { id: string }) => f.id));

  const store = deps.store();
  const current = await store.readAll();
  if (current.size === 0) {
    // Against an empty table every next entry looks added and the additive gate checks nothing.
    throw new RefusalError("siting_context is empty: run `npm run backfill:siting -- --apply` first");
  }
  // diffSitingContext compares with JSON.stringify, and Postgres jsonb does not
  // keep key order, so stored rows would read as "changed" against a file with
  // the same data. Canonicalize (sorted keys) both sides first; the check script's
  // file-vs-file use is untouched.
  const canon = (e: unknown) => JSON.parse(canonicalJson(e)) as Entries[string];
  const old = Object.fromEntries([...current].map(([k, v]) => [k, canon(v)])) as Entries;
  const nextCanon = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, canon(v)])) as Entries;
  const diff = diffSitingContext(old, nextCanon, liveIds);

  if (!isAdditive(diff)) {
    const sample = (xs: Array<string | { id: string; field: string }>) =>
      xs
        .slice(0, PRINT_LIMIT)
        .map((x) => (typeof x === "string" ? x : `${x.id}.${x.field}`))
        .join(", ");
    throw new RefusalError(
      `siting:apply refused, the whole write is blocked: removed ${diff.removed.length} [${sample(diff.removed)}], ` +
        `lost ${diff.lost.length} [${sample(diff.lost)}], nulled ${diff.nulled.length} [${sample(diff.nulled)}]`,
    );
  }

  // The write set is every id whose canonical value differs from the stored one,
  // NOT diff.added/changed: diffSitingContext walks only the OLD entry's fields, so
  // a field that is new on an existing id (what a backfill-nhd fill looks like)
  // never shows up in `changed`. The diff above is only the refusal gate.
  const addedIds: string[] = [];
  const changedIds: string[] = [];
  for (const [key, entry] of Object.entries(nextCanon)) {
    if (!(key in old)) addedIds.push(key);
    else if (canonicalJson(old[key]) !== canonicalJson(entry)) changedIds.push(key);
  }
  // New ids insert with DO NOTHING; changed ids overwrite. One call = one transaction on Neon.
  const rows: KeyedRow[] = [
    ...addedIds.map((key) => ({ key, data: next[key], onConflict: "nothing" as const })),
    ...changedIds.map((key) => ({ key, data: next[key], onConflict: "update" as const })),
  ];
  deps.log(
    `siting_context (${apply ? "applied" : "dry run"}): next ${Object.keys(next).length}; ` +
      `add ${addedIds.length}, change ${changedIds.length}, pruned-not-deleted ${diff.pruned.length}`,
  );
  if (apply && rows.length > 0) {
    await store.upsert(rows);
    await verifyRows(store, new Map(rows.map((r) => [r.key, r.data])), "siting_context");
  }
}

if (isEntrypoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!hasDatabaseUrl()) {
    console.error("siting:apply needs DATABASE_URL (it compares against the live rows)");
    process.exit(1);
  }
  run(process.argv.slice(2), {
    root,
    readFile: (f) => readFileSync(f, "utf8"),
    store: sitingStore,
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
