/**
 * Maintainer tool: create (or rotate) the least-privilege `ci_monitor` Postgres
 * role that the GitHub Actions `DATABASE_URL` secret should hold.
 *
 * Why: the two read-only workflows (`schema-check`, `discovery-watchdog`) only
 * SELECT from three tables, yet the secret held the Neon OWNER credential. A
 * leak of that secret was a full read/write/DDL compromise.
 *
 * Dry run is the default and is fully offline (no connection, no password
 * generated). `--apply` connects with the owner `DATABASE_URL`, so run it as
 *
 *   npx tsx --env-file=.env.local scripts/ops/create-ci-monitor-role.ts --apply --out <path>
 *
 * The new connection URL goes ONLY to `--out` (mode 0600, never overwritten);
 * neither it nor the password is ever printed. Neon rejects hashed (SCRAM)
 * passwords, so the password goes as a plain-text literal in CREATE/ALTER ROLE,
 * inside the TLS connection; Neon stores it encrypted. Driver errors can echo
 * the statement, so no error text is ever printed, only redactedErrorCode().
 * Whether Neon's server-side statement logging could capture the literal is not
 * verifiable from here, which is why the role is least-privilege and rotatable
 * with --rotate.
 */
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { neon } from "@neondatabase/serverless";

import { redactedErrorCode } from "../../lib/db-error";
import { isEntrypoint } from "../is-entrypoint";

export const ROLE = "ci_monitor";

/**
 * Whole tables the CI workflows read: check-schema-drift.ts (`api_daily_usage`),
 * discovery/check-heartbeat.ts (`discovery_heartbeat`) and the digest runs read by
 * discovery/check-digest-status.ts and ops/check-cron-freshness.ts
 * (`state_digest_runs`). Table listing goes through pg_catalog.pg_tables, which
 * needs no grant.
 */
export const GRANTED_TABLES = [
  "api_daily_usage",
  "discovery_heartbeat",
  "state_digest_runs",
] as const;

/**
 * Tables granted COLUMN-level only, because they hold data CI must not read:
 * `subscriptions.email` (every subscriber's address), `email_sends` (its
 * `email_hash` is kept: a salted hash that collapses a recipient's retry chain; the
 * resend id and target columns are not) and `paypal_webhook_events` (ids and payer
 * linkage). Each list is exactly what the queries in check-digest-status.ts
 * and check-cron-freshness.ts name, including their WHERE columns. Widening a
 * query to another column fails under this role until it is added here AND
 * granted by the maintainer.
 *
 * `email_hash` plus `subscription_id` give a pseudonymous per-recipient send history.
 * That is safe ONLY because CI never holds CONTRIBUTE_IP_SALT (the hash salt): never add
 * that salt to any watchdog workflow's env, or the hashes become reversible for known addresses.
 */
export const GRANTED_COLUMNS = {
  subscriptions: ["status", "target_type"],
  email_sends: ["id", "created_at", "kind", "email_hash", "subscription_id", "run_id", "outcome", "error_code"],
  paypal_webhook_events: ["received_at", "processed_at"],
  dataset_editions: ["built_at", "status"],
} as const satisfies Record<string, readonly string[]>;

/** One statement per column-granted table, e.g. `GRANT SELECT (status, target_type) ON subscriptions TO ci_monitor`. */
export function columnGrantStatements(): string[] {
  return Object.entries(GRANTED_COLUMNS).map(
    ([table, cols]) => `GRANT SELECT (${cols.join(", ")}) ON ${table} TO ${ROLE}`,
  );
}

const REDACTED = "<redacted>";

/** Fixed-message errors that are safe to print verbatim (they never embed input). */
export class UsageError extends Error {}

const ROLE_ATTRS =
  "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5";

export interface CliOptions {
  apply: boolean;
  rotate: boolean;
  out: string | null;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let values: { apply?: boolean; rotate?: boolean; out?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        apply: { type: "boolean", default: false },
        rotate: { type: "boolean", default: false },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // Node's own message echoes the offending argument; print a fixed one.
    throw new UsageError("invalid arguments (flags: --apply, --rotate, --out <path>)");
  }
  const opts: CliOptions = {
    apply: values.apply === true,
    rotate: values.rotate === true,
    out: values.out ?? null,
  };
  if (opts.apply && !opts.out) {
    throw new UsageError(
      "--out <path> is required with --apply (the new URL is written only there).",
    );
  }
  if (!opts.apply && opts.out) {
    throw new UsageError(
      "--out only applies with --apply (a dry run generates no credential).",
    );
  }
  return opts;
}

/**
 * Neon requires a plain-text password in CREATE/ALTER ROLE (min 60 bits of
 * entropy; hashed passwords are rejected, https://neon.com/docs/manage/roles)
 * and stores it encrypted. 32 random bytes is 256 bits. The fixed suffix only
 * guarantees upper, lower, digit and symbol classes in case a checker wants
 * character diversity; it adds no entropy and is not relied on.
 */
const PASSWORD_SUFFIX = "-Aa1";
const PASSWORD_SHAPE = /^[A-Za-z0-9_-]{40,}$/;

export function generatePassword(): string {
  return randomBytes(32).toString("base64url") + PASSWORD_SUFFIX;
}

/** Interpolation guard: the alphabet has no quote or backslash, so a literal is injection-safe. */
export function assertSafePassword(password: string): void {
  if (!PASSWORD_SHAPE.test(password)) {
    throw new UsageError("generated password has an unexpected shape; refusing to build SQL");
  }
}

/** Same host/database/params as the owner URL; only the credentials change. */
export function buildCiUrl(ownerUrl: string, password: string): string {
  let url: URL;
  try {
    url = new URL(ownerUrl);
  } catch {
    // Node's TypeError message embeds the input, i.e. the owner credential.
    throw new UsageError("DATABASE_URL is not a valid URL");
  }
  url.username = ROLE;
  url.password = password;
  return url.toString();
}

/**
 * The write plan, in order. `quotedDb` must already be a quoted identifier
 * (quote_ident(current_database())). The password is the only credential-derived
 * value in the SQL; dry runs pass a placeholder.
 */
export function buildPlan(
  quotedDb: string,
  password: string,
  roleExists: boolean | "unknown",
): string[] {
  if (password !== REDACTED) assertSafePassword(password);
  const attrs = `LOGIN ${ROLE_ATTRS} PASSWORD '${password}'`;
  const first =
    roleExists === "unknown"
      ? `CREATE ROLE ${ROLE} ${attrs}  -- or ALTER ROLE ... when the role exists (requires --rotate)`
      : roleExists
        ? `ALTER ROLE ${ROLE} ${attrs}`
        : `CREATE ROLE ${ROLE} ${attrs}`;
  return [
    first,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`,
    `GRANT CONNECT ON DATABASE ${quotedDb} TO ${ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE}`,
    `GRANT SELECT ON ${GRANTED_TABLES.join(", ")} TO ${ROLE}`,
    ...columnGrantStatements(),
    `ALTER ROLE ${ROLE} SET default_transaction_read_only = on`,
    `ALTER ROLE ${ROLE} SET statement_timeout = '30s'`,
  ];
}

export type Sql = { query: (text: string) => Promise<unknown> };

async function rows<T>(sql: Sql, text: string): Promise<T[]> {
  return (await sql.query(text)) as T[];
}

export interface VerifyResult {
  name: string;
  ok: boolean;
}

/** Connects AS ci_monitor and checks the grants actually bite. No secrets in results. */
export async function verifyRole(
  sql: Sql,
  expectedTables: number,
  error: (line: string) => void = (line) => console.error(line),
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      results.push({ name, ok: await fn() });
    } catch (err) {
      error(`verify step "${name}" errored (${redactedErrorCode(err)})`);
      results.push({ name, ok: false });
    }
  };

  for (const table of GRANTED_TABLES) {
    await check(`SELECT on ${table}`, async () => {
      await sql.query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    });
  }
  for (const [table, cols] of Object.entries(GRANTED_COLUMNS)) {
    await check(`SELECT (${cols.join(", ")}) on ${table}`, async () => {
      await sql.query(`SELECT ${cols.join(", ")} FROM ${table} LIMIT 1`);
      return true;
    });
  }
  await check("column-readable columns are exactly the granted columns", async () => {
    // Via pg_class/pg_attribute oids, like the relation check below. Table-level
    // grants make every column readable, so those tables are excluded by name.
    const found = await rows<{ relname: string; attname: string }>(
      sql,
      `SELECT c.relname, a.attname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname IN (${Object.keys(GRANTED_COLUMNS).map((t) => `'${t}'`).join(", ")})
          AND has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')`
    );
    const got = found.map((r) => `${r.relname}.${r.attname}`).sort();
    const want = Object.entries(GRANTED_COLUMNS)
      .flatMap(([t, cols]) => cols.map((c) => `${t}.${c}`))
      .sort();
    return JSON.stringify(got) === JSON.stringify(want);
  });
  await check("no table-level privilege on the column-granted tables", async () => {
    // has_table_privilege ignores column grants, so any hit is a stray table-level GRANT
    // (e.g. an ad-hoc `GRANT SELECT ON subscriptions`) that would expose every column.
    const found = await rows<{ relname: string }>(
      sql,
      `SELECT DISTINCT c.relname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS priv
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname IN (${Object.keys(GRANTED_COLUMNS).map((t) => `'${t}'`).join(", ")})
          AND has_table_privilege(current_user, c.oid, priv)`
    );
    return found.length === 0;
  });
  await check("INSERT into api_daily_usage is refused", async () => {
    try {
      await sql.query("INSERT INTO api_daily_usage DEFAULT VALUES");
      return false;
    } catch (err) {
      // 42501 insufficient_privilege; 25006 read_only_sql_transaction (the
      // role-level read-only default can fire first). Either means refused.
      const code = redactedErrorCode(err);
      return code === "42501" || code === "25006";
    }
  });
  await check("role holds no INSERT on api_daily_usage", async () => {
    const [r] = await rows<{ p: boolean }>(
      sql,
      "SELECT has_table_privilege(current_user, 'public.api_daily_usage', 'INSERT') AS p",
    );
    return r?.p === false;
  });
  await check("SELECT-able public relations are exactly the granted tables", async () => {
    // Via pg_class oid: has_table_privilege(quote_ident(name)) fails on Neon.
    const found = await rows<{ relname: string }>(
      sql,
      `SELECT c.relname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND has_table_privilege(current_user, c.oid, 'SELECT')`
    );
    const names = found.map((r) => r.relname).sort();
    return JSON.stringify(names) === JSON.stringify([...GRANTED_TABLES].sort());
  });
  await check("no CREATE on schema public", async () => {
    const [r] = await rows<{ p: boolean }>(sql, "SELECT has_schema_privilege('public', 'CREATE') AS p");
    return r?.p === false;
  });
  await check("no CREATE on the database", async () => {
    const [r] = await rows<{ p: boolean }>(
      sql,
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS p"
    );
    return r?.p === false;
  });
  await check("member of no role", async () => {
    const [r] = await rows<{ n: number }>(
      sql,
      `SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = current_user`
    );
    return r?.n === 0;
  });
  await check("pg_tables lists the full public table set", async () => {
    const found = await rows<{ tablename: string }>(
      sql,
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
    );
    return (
      found.length >= expectedTables && found.length > GRANTED_TABLES.length
    );
  });
  return results;
}

export interface RunDeps {
  connect: (url: string) => Sql;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Injectable for tests; defaults to generatePassword. */
  generatePassword?: () => string;
}

const defaultDeps: RunDeps = {
  connect: (url) => neon(url) as unknown as Sql,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Returns the process exit code. Everything printed is a fixed string, a
 * redactedErrorCode() value or an fs errno code: never an error message, which
 * could carry the owner URL (URL parse errors) or the plaintext password (driver
 * errors echo the statement).
 */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: RunDeps = defaultDeps
): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    deps.error(err instanceof UsageError ? err.message : "invalid arguments");
    return 1;
  }

  if (!opts.apply) {
    deps.log("DRY RUN (no connection made). Plan, run as the owner role:");
    for (const stmt of buildPlan("<current database>", REDACTED, "unknown")) {
      deps.log(`  ${stmt};`);
    }
    deps.log("Then: verify as ci_monitor (grants, no CREATE, no role membership, INSERT refused).");
    deps.log("Re-run with --apply --out <path> to write. An existing role also needs --rotate.");
    return 0;
  }

  const ownerUrl = env.DATABASE_URL;
  if (!ownerUrl) {
    deps.error("DATABASE_URL (owner) is not set.");
    return 1;
  }

  const password = (deps.generatePassword ?? generatePassword)();
  let ciUrl: string;
  try {
    assertSafePassword(password);
    ciUrl = buildCiUrl(ownerUrl, password);
  } catch (err) {
    deps.error(err instanceof UsageError ? err.message : "DATABASE_URL could not be used");
    return 1;
  }
  const out = opts.out as string;

  // Persist the credential BEFORE touching the database: if the write to disk
  // fails nothing has changed, and if the SQL fails we remove the file again.
  // No trailing newline: `gh secret set < file` would store it.
  try {
    writeFileSync(out, ciUrl, { flag: "wx", mode: 0o600 });
  } catch (err) {
    const code = typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "unknown";
    deps.error(`Cannot create the --out file (${/^[A-Z0-9_]{2,40}$/.test(code) ? code : "unknown"}); refusing to continue.`);
    return 1;
  }

  try {
    const sql = deps.connect(ownerUrl);
    const [db] = await rows<{ q: string }>(sql, "SELECT quote_ident(current_database()) AS q");
    const existing = await rows<{ one: number }>(sql, `SELECT 1 AS one FROM pg_roles WHERE rolname = '${ROLE}'`);
    const roleExists = existing.length > 0;
    if (roleExists && !opts.rotate) {
      throw new UsageError(`role ${ROLE} already exists; pass --rotate to set a new password`);
    }
    for (const stmt of buildPlan(db.q, password, roleExists)) {
      await sql.query(stmt);
    }
    const [{ n }] = await rows<{ n: number }>(
      sql,
      "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
    );
    const results = await verifyRole(deps.connect(ciUrl), n, deps.error);
    for (const r of results) deps.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    if (results.some((r) => !r.ok)) {
      deps.error(
        "Verification failed; the --out file was kept (the role and password exist). Fix and re-run with --rotate."
      );
      return 1;
    }
    deps.log(`OK: ${ROLE} ${roleExists ? "rotated" : "created"}; URL written to --out (mode 0600).`);
    return 0;
  } catch (err) {
    // A failure after ALTER ROLE ... PASSWORD leaves the old CI secret dead
    // until --rotate succeeds; the file is removed because its URL may not match.
    try {
      unlinkSync(out);
    } catch {
      // best effort
    }
    deps.error(
      `${err instanceof UsageError ? err.message : `database error (${redactedErrorCode(err)})`}; removed the --out file.`
    );
    return 1;
  }
}

/** Backstop: whatever escapes run() prints a fixed string plus an error code, never the error. */
export async function runGuarded(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: RunDeps = defaultDeps
): Promise<number> {
  try {
    return await run(argv, env, deps);
  } catch (err) {
    deps.error(`unexpected failure (${redactedErrorCode(err)})`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  runGuarded(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("unexpected failure");
      process.exitCode = 1;
    });
}
