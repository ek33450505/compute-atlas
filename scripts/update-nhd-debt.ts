/**
 * NHD backfill debt ledger: counts the CONUS facilities in
 * data/siting-context.json that still lack `nearestWater` and keeps
 * data/nhd-backfill-debt.json equal to that count.
 *
 * lib/siting-context.test.ts is a ratchet against the ledger: it fails when the
 * live count is above the recorded ceiling (unrecorded growth) AND when it is
 * below (a silent paydown), so every wave that moves the debt has to move the
 * ledger in the same PR. The ceiling used to be a literal inside that test, which
 * meant a degraded-NHD wave needed a hand edit to a test file; this script is
 * the single entry point for humans and automation alike.
 *
 *   npx tsx scripts/update-nhd-debt.ts --count            print the integer only; write nothing
 *   npx tsx scripts/update-nhd-debt.ts [--note "<why>"]   rewrite the ledger iff the count moved
 *   ... --ledger-db                                       ALSO sync the Neon maintenance_ledger row (needs DATABASE_URL)
 *
 * An unchanged count writes nothing, so `asOf` does not churn. Exits non-zero if
 * either data file is unreadable or not JSON, or if the ledger exists but is
 * malformed (a malformed ledger is reported, never overwritten).
 *
 * Counting rules (orphans and non-CONUS states are not debt) live in
 * lib/nhd-debt.ts. Uses relative imports, matching the other scripts here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  missingNearestWaterOffenders,
  perStateBreakdown,
  planLedgerUpdate,
  type FacilityStateRow,
  type SitingEntryRow,
} from "../lib/nhd-debt";
import type { KeyedStore } from "../lib/closed-data-store";
import { isEntrypoint } from "./is-entrypoint";

export const LEDGER_RELATIVE_PATH = "data/nhd-backfill-debt.json";

export interface CliArgs {
  countOnly: boolean;
  note?: string;
  /** Also keep the `maintenance_ledger` row `nhd_backfill_debt` in Neon equal to the count. */
  ledgerDb?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { countOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--count") {
      args.countOnly = true;
    } else if (arg === "--ledger-db") {
      args.ledgerDb = true;
    } else if (arg === "--note") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--note requires a value");
      args.note = value;
    } else if (arg.startsWith("--note=")) {
      args.note = arg.slice("--note=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.countOnly && args.note !== undefined) {
    throw new Error("--count writes nothing, so --note has no effect; drop one of them");
  }
  if (args.countOnly && args.ledgerDb) {
    throw new Error("--count writes nothing, so --ledger-db has no effect; drop one of them");
  }
  return args;
}

function readJson(file: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${label} (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} (${file}) is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// undefined = the file does not exist (the ledger is then written fresh); an
// unreadable or unparseable file still throws.
function readLedgerIfPresent(file: string): unknown {
  return existsSync(file) ? readJson(file, LEDGER_RELATIVE_PATH) : undefined;
}

function countDebt(root: string): { count: number; offenders: ReturnType<typeof missingNearestWaterOffenders> } {
  const facilities = readJson(path.join(root, "data/facilities.json"), "data/facilities.json");
  const sitingContext = readJson(path.join(root, "data/siting-context.json"), "data/siting-context.json");
  if (!Array.isArray(facilities)) {
    throw new Error("data/facilities.json is not a JSON array");
  }
  if (typeof sitingContext !== "object" || sitingContext === null || Array.isArray(sitingContext)) {
    throw new Error("data/siting-context.json is not a JSON object keyed by facility id");
  }

  const offenders = missingNearestWaterOffenders(
    facilities as FacilityStateRow[],
    sitingContext as Record<string, SitingEntryRow>,
  );
  return { count: offenders.length, offenders };
}

export function run(argv: string[], root: string, today: string): void {
  const args = parseArgs(argv);
  const { count, offenders } = countDebt(root);

  if (args.countOnly) {
    console.log(String(count));
    return;
  }

  const ledgerPath = path.join(root, LEDGER_RELATIVE_PATH);
  const plan = planLedgerUpdate(count, readLedgerIfPresent(ledgerPath), args.note, today);

  console.log(`NHD debt: ${count} (ledger was ${plan.previous ?? "missing"})`);
  if (count > 0) console.log(`Per-state breakdown: ${perStateBreakdown(offenders)}`);

  if (plan.next !== null) {
    writeFileSync(ledgerPath, `${JSON.stringify(plan.next, null, 2)}\n`);
    console.log(`Wrote ${LEDGER_RELATIVE_PATH}: ceiling ${plan.previous ?? "missing"} -> ${count}`);
  }
}

export const LEDGER_DB_KEY = "nhd_backfill_debt";

// `--ledger-db`: the file ledger run, then the same plan against the Neon
// `maintenance_ledger` row. Opt-in; `run` alone is the unchanged default.
// Order: read Neon FIRST (a read failure or a malformed row aborts before the
// file is touched), then write the file, then Neon. Guaranteed: a Neon outage or
// bad row never leaves the file moved. NOT guaranteed: a Neon WRITE failure after
// the file write leaves the file ahead of Neon; a re-run reconciles it, because
// the file then matches the count and the Neon plan is computed on its own.
export async function runWithLedgerDb(
  argv: string[],
  root: string,
  today: string,
  store: KeyedStore,
): Promise<void> {
  const args = parseArgs(argv);
  const { count } = countDebt(root);
  const current = (await store.readAll()).get(LEDGER_DB_KEY);
  const plan = planLedgerUpdate(count, current, args.note, today); // throws on a malformed row
  run(argv, root, today);
  console.log(`NHD debt (Neon ${LEDGER_DB_KEY}): ${count} (ledger was ${plan.previous ?? "missing"})`);
  if (plan.next !== null) {
    await store.upsert([{ key: LEDGER_DB_KEY, data: plan.next }]);
    console.log(`Wrote maintenance_ledger ${LEDGER_DB_KEY}: ceiling ${plan.previous ?? "missing"} -> ${count}`);
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by a test suite — matches scripts/census-diff.ts's isMain guard.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const today = new Date().toISOString().slice(0, 10); // UTC
  const argv = process.argv.slice(2);
  try {
    if (parseArgs(argv).ledgerDb) {
      // Checked BEFORE anything is written, so a missing URL cannot leave the
      // file ledger moved while the Neon row is not.
      if (!process.env.DATABASE_URL) {
        throw new Error("--ledger-db needs DATABASE_URL; nothing was written");
      }
      // Opt-in path only: loaded lazily so the default path never touches DB code.
      import("../lib/closed-data-store")
        .then(({ ledgerStore }) => runWithLedgerDb(argv, root, today, ledgerStore()))
        .catch(async (err) => {
          const { formatFatalError } = await import("../lib/db-error");
          console.error(formatFatalError(err));
          process.exit(1);
        });
    } else {
      run(argv, root, today);
    }
  } catch (err) {
    // lint-no-raw-error-logs: allow -- local ledger/argv errors only; imports no DB code, and the CLI test pins this exact stderr text
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
