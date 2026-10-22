/**
 * Read-only CLI over the `email_sends` ledger. Shows what was mailed and how
 * each send ended; it never writes.
 *
 * Run via: npm run email-sends -- [--email <addr>|--email -] [--run <uuid>]
 *          [--kind <kind>] [--outcome <outcome>] [--since YYYY-MM-DD] [--limit N]
 *
 * WARNING: `--email <addr>` leaves the address in shell history. Use
 * `--email -` (reads the address from stdin) instead.
 *
 * Address lookups need CONTRIBUTE_IP_SALT set to production's value; without
 * it the CLI exits 2 rather than hash with the public default salt.
 * The address is hashed here and is never printed; output shows only an
 * 8-character hash prefix per row.
 *
 * Uses relative imports, matching scripts/retention-prune.ts.
 */
import { readFileSync } from "node:fs";

import { getDb } from "../lib/db/client";
import { redactedErrorCode } from "../lib/db-error";
import { EMAIL_SEND_KINDS, EMAIL_SEND_OUTCOMES, addressLookupAvailable, hashAddress } from "../lib/email-sends";
import {
  EMAIL_SENDS_MAX_LIMIT,
  countEmailSendsByOutcome,
  isEmailSendKind,
  isEmailSendOutcome,
  isUuid,
  listEmailSends,
  parseIsoDate,
  type EmailSendListed,
  type EmailSendsFilter,
} from "../lib/email-sends-query";
import { isEntrypoint } from "./is-entrypoint";

export interface CliOptions {
  email?: string;
  run?: string;
  kind?: string;
  outcome?: string;
  since?: string;
  limit?: number;
}

export class UsageError extends Error {}

const USAGE =
  "Usage: email-sends [--email -] [--run <uuid>] [--kind <kind>] [--outcome <outcome>] [--since YYYY-MM-DD] [--limit N]\n" +
  "Note: `--email <addr>` stays in shell history; use `--email -` to read the address from stdin.";

/** Strict: unknown flags, missing values and invalid values throw `UsageError` (a bad filter must not silently widen the output). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--email", "--run", "--kind", "--outcome", "--since", "--limit"].includes(flag)) {
      throw new UsageError(`Unknown argument: ${flag.startsWith("--") ? flag : "(positional)"}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    i++;
    switch (flag) {
      case "--email":
        opts.email = value;
        break;
      case "--run":
        if (!isUuid(value)) throw new UsageError("--run must be a UUID");
        opts.run = value;
        break;
      case "--kind":
        if (!isEmailSendKind(value)) throw new UsageError(`--kind must be one of: ${EMAIL_SEND_KINDS.join(", ")}`);
        opts.kind = value;
        break;
      case "--outcome":
        if (!isEmailSendOutcome(value)) {
          throw new UsageError(`--outcome must be one of: ${EMAIL_SEND_OUTCOMES.join(", ")}`);
        }
        opts.outcome = value;
        break;
      case "--since":
        if (!parseIsoDate(value)) throw new UsageError("--since must be a date as YYYY-MM-DD");
        opts.since = value;
        break;
      case "--limit": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > EMAIL_SENDS_MAX_LIMIT) {
          throw new UsageError(`--limit must be an integer from 1 to ${EMAIL_SENDS_MAX_LIMIT}`);
        }
        opts.limit = n;
        break;
      }
    }
  }
  return opts;
}

export interface CliDeps {
  /** Reads all of stdin; only called for `--email -`. */
  readStdin: () => string;
  query: (filter: EmailSendsFilter) => Promise<{
    rows: EmailSendListed[];
    counts: Record<string, number>;
  }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 19) + "Z" : "-");

function formatRow(r: EmailSendListed): string {
  const target = r.targetType ? `${r.targetType}:${r.targetId ?? ""}` : "-";
  return [
    iso(r.createdAt),
    r.hashPrefix,
    r.kind,
    r.outcome,
    target,
    r.errorCode ?? "-",
    r.resendId ?? "-",
    r.runId ?? "-",
  ].join("  ");
}

/** Returns the process exit code. Never prints the address. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(e.message);
      deps.err(USAGE);
      return 1;
    }
    throw e;
  }

  const filter: EmailSendsFilter = {
    kind: opts.kind,
    outcome: opts.outcome,
    since: opts.since,
    runId: opts.run,
    limit: opts.limit,
  };

  if (opts.email !== undefined) {
    const address = (opts.email === "-" ? deps.readStdin() : opts.email).trim();
    if (!address.includes("@")) {
      deps.err("--email needs an email address (or - to read it from stdin)");
      return 1;
    }
    if (!addressLookupAvailable()) {
      deps.err(
        "Address lookup needs CONTRIBUTE_IP_SALT set to production's value (it is unset here, so any hash would silently match nothing). --run/--kind/--outcome/--since lookups still work."
      );
      return 2;
    }
    try {
      filter.emailHash = hashAddress(address);
    } catch {
      deps.err("Could not hash the address (is CONTRIBUTE_IP_SALT set?)");
      return 1;
    }
    deps.out("address: <provided, hashed>");
  }

  let result;
  try {
    result = await deps.query(filter);
  } catch (e) {
    // Code only: Drizzle errors embed bound params, which here include the address hash.
    deps.err(`Query failed (sqlstate: ${redactedErrorCode(e)})`);
    return 1;
  }

  deps.out("created               hash      kind  outcome  target  error  resend  run");
  for (const row of result.rows) deps.out(formatRow(row));
  deps.out(`${result.rows.length} row(s) shown`);
  const counts = Object.entries(result.counts).sort(([a], [b]) => a.localeCompare(b));
  deps.out(`outcomes: ${counts.length ? counts.map(([k, n]) => `${k}=${n}`).join(" ") : "none"}`);
  return 0;
}

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2), {
    readStdin: () => readFileSync(0, "utf8"),
    query: async (filter) => {
      const db = getDb();
      return {
        rows: await listEmailSends(db, filter),
        counts: await countEmailSendsByOutcome(db, filter),
      };
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
  process.exit(code);
}

// Only run when executed directly, not when imported by the test suite.
if (isEntrypoint(import.meta.url)) {
  main().catch((e) => {
    console.error(`email-sends failed (sqlstate: ${redactedErrorCode(e)})`);
    process.exit(1);
  });
}
