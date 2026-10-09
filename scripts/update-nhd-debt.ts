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
import { isEntrypoint } from "./is-entrypoint";

export const LEDGER_RELATIVE_PATH = "data/nhd-backfill-debt.json";

export interface CliArgs {
  countOnly: boolean;
  note?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { countOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--count") {
      args.countOnly = true;
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

export function run(argv: string[], root: string, today: string): void {
  const args = parseArgs(argv);

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
  const count = offenders.length;

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

// Only run the CLI when this file is executed directly, not when its exports
// are imported by a test suite — matches scripts/census-diff.ts's isMain guard.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const today = new Date().toISOString().slice(0, 10); // UTC
  try {
    run(process.argv.slice(2), root, today);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
