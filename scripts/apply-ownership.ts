/**
 * Publish the curated operator-ownership file to the Neon `operator_ownership` table.
 * DRY RUN IS THE DEFAULT and needs no DATABASE_URL (it then only reports the source count).
 *
 *   npm run ownership:apply                         dry run: insert/update/unchanged counts
 *   npm run ownership:apply -- --apply              insert + update, then read back and verify
 *   npm run ownership:apply -- --file <path>        use another file than data/operator-ownership.json
 *
 * The file is validated with operatorOwnershipFileSchema and duplicate operator keys are
 * refused, BEFORE the database is touched. The row key is the EXACT `operator` string.
 * Rows in Neon that the file lacks (removals) are REFUSED in every mode: a dry run warns,
 * --apply exits non-zero having written nothing. There is no delete code and no flag
 * (Ed, 2026-11-06). Changed rows overwrite (ON CONFLICT DO UPDATE, no compare-and-set;
 * acceptable for a sole-maintainer local command).
 *
 * After a successful write it busts `operator:<slug>` for each inserted or updated operator
 * plus `facilities`; needs API_BASE_URL + API_ADMIN_TOKEN, checked before any write, unless
 * --skip-revalidate. A bust failure keeps the write and exits non-zero.
 *
 * Uses relative imports, matching the other scripts here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyKeyed,
  formatApplyReport,
  ownershipStore,
  RefusalError,
} from "../lib/closed-data-store";
import { formatFatalError } from "../lib/db-error";
import { hasDatabaseUrl } from "../lib/db/client";
import { operatorOwnershipFileSchema } from "../lib/operator-ownership";
import { operatorSlug } from "../lib/operator-slug";
import { assertValidTags, bustAfterUpserts, resolveRevalidate } from "./bust-tags";
import { isEntrypoint } from "./is-entrypoint";
import type { Deps } from "./backfill-siting-to-neon";

const DEFAULT_FILE = "data/operator-ownership.json";

export function parseArgs(argv: string[]): { apply: boolean; skipRevalidate: boolean; file: string | null } {
  let apply = false;
  let skipRevalidate = false;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--skip-revalidate") skipRevalidate = true;
    else if (arg === "--file") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--file needs a path");
      file = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return { apply, skipRevalidate, file };
}

export function loadSource(deps: Pick<Deps, "root" | "readFile">, file: string | null): Map<string, unknown> {
  const label = file ?? DEFAULT_FILE;
  let text: string;
  try {
    text = deps.readFile(path.resolve(deps.root, label));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new RefusalError(`${label}: file not found`);
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Fixed text: the parser message can echo a snippet of the file.
    throw new RefusalError(`${label}: not valid JSON`);
  }
  const parsed = operatorOwnershipFileSchema.safeParse(raw);
  if (!parsed.success) {
    // Paths and messages only: zod issues never echo the input values.
    const first = parsed.error.issues[0];
    throw new RefusalError(
      `${label} fails operatorOwnershipFileSchema (${parsed.error.issues.length} issue(s); first at ${first.path.join(".") || "(root)"}: ${first.message})`,
    );
  }
  const source = new Map<string, unknown>();
  for (const entry of parsed.data) {
    if (source.has(entry.operator)) throw new RefusalError(`${label} lists operator twice: ${entry.operator}`);
    source.set(entry.operator, entry);
  }
  return source;
}

/** The tags one changed-operator set invalidates: each operator's rail, plus the whole-table read. */
export function ownershipTags(operators: string[]): string[] {
  return [...new Set(operators.map((op) => `operator:${operatorSlug(op)}`)), "facilities"];
}

export async function run(argv: string[], deps: Deps): Promise<void> {
  const { apply, skipRevalidate, file } = parseArgs(argv);
  const revalidate = resolveRevalidate({ apply, skipRevalidate, env: deps.env ?? process.env });
  const source = loadSource(deps, file);
  // Validate the superset (every source operator) so a bad tag aborts before any write.
  if (apply) assertValidTags(ownershipTags([...source.keys()]));
  const store = deps.store();
  const label = "operator_ownership";
  const report = store
    ? await bustAfterUpserts({ store, tagsFor: ownershipTags, config: revalidate, deps }, (st) =>
        applyKeyed({ source, store: st, apply, label }),
      )
    : await applyKeyed({ source, store: null, apply, label });
  deps.log(formatApplyReport(label, report));
}

if (isEntrypoint(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  run(process.argv.slice(2), {
    root,
    readFile: (f) => readFileSync(f, "utf8"),
    store: () => (hasDatabaseUrl() ? ownershipStore() : null),
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
