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
 * neither it nor the password is ever printed. The password is installed as a
 * client-computed SCRAM-SHA-256 verifier (RFC 5802/7677, what psql's \\password
 * does), so the plaintext never appears in SQL or server logs.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { neon } from "@neondatabase/serverless";

import { redactedErrorCode } from "../../lib/db-error";
import { isEntrypoint } from "../is-entrypoint";

export const ROLE = "ci_monitor";

/**
 * Tables the CI workflows read: check-schema-drift.ts (`api_daily_usage`),
 * discovery/check-heartbeat.ts (`discovery_heartbeat`) and
 * discovery/check-digest-status.ts (`state_digest_runs`). Table listing goes
 * through pg_catalog.pg_tables, which needs no grant.
 */
export const GRANTED_TABLES = [
  "api_daily_usage",
  "discovery_heartbeat",
  "state_digest_runs",
] as const;

const SCRAM_ITERATIONS = 4096;
const REDACTED = "<scram-verifier-redacted>";

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

/** RFC 5802 key derivation (SaltedPassword, ClientKey, StoredKey, ServerKey). */
export function scramKeys(password: string, salt: Buffer, iterations: number) {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return { clientKey, storedKey, serverKey };
}

/** RFC 5802 / 7677 verifier in Postgres's stored format. */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS
): string {
  const { storedKey, serverKey } = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
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
 * (quote_ident(current_database())). The verifier is the only credential-derived
 * value in the SQL; dry runs pass a placeholder.
 */
export function buildPlan(
  quotedDb: string,
  verifier: string,
  roleExists: boolean | "unknown",
): string[] {
  const password = `PASSWORD '${verifier}'`;
  const attrs = `LOGIN ${ROLE_ATTRS} ${password}`;
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
    `ALTER ROLE ${ROLE} SET default_transaction_read_only = on`,
    `ALTER ROLE ${ROLE} SET statement_timeout = '30s'`,
  ];
}

export type Sql = { query: (text: string) => Promise<unknown> };

async function rows<T>(sql: Sql, text: string): Promise<T[]> {
  return (await sql.query(text)) as T[];
}

function errCode(err: unknown): string {
  return redactedErrorCode(err);
}

export interface VerifyResult {
  name: string;
  ok: boolean;
}

/** Connects AS ci_monitor and checks the grants actually bite. No secrets in results. */
export async function verifyRole(sql: Sql, expectedTables: number): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      results.push({ name, ok: await fn() });
    } catch (err) {
      console.error(`verify step "${name}" errored (${errCode(err)})`);
      results.push({ name, ok: false });
    }
  };

  for (const table of GRANTED_TABLES) {
    await check(`SELECT on ${table}`, async () => {
      await sql.query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    });
  }
  await check("INSERT into api_daily_usage is refused", async () => {
    try {
      await sql.query("INSERT INTO api_daily_usage DEFAULT VALUES");
      return false;
    } catch (err) {
      // 42501 insufficient_privilege; 25006 read_only_sql_transaction (the
      // role-level read-only default can fire first). Either means refused.
      const code = errCode(err);
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
}

const defaultDeps: RunDeps = {
  connect: (url) => neon(url) as unknown as Sql,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Returns the process exit code. Everything printed is a fixed string, a
 * redactedErrorCode() value or an fs errno code: never an error message, which
 * could carry the owner URL (URL parse errors) or the SCRAM verifier (driver
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

  const password = generatePassword();
  let ciUrl: string;
  try {
    ciUrl = buildCiUrl(ownerUrl, password);
  } catch (err) {
    deps.error(err instanceof UsageError ? err.message : "DATABASE_URL could not be used");
    return 1;
  }
  const verifier = scramSha256Verifier(password);
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
    for (const stmt of buildPlan(db.q, verifier, roleExists)) {
      await sql.query(stmt);
    }
    const [{ n }] = await rows<{ n: number }>(
      sql,
      "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
    );
    const results = await verifyRole(deps.connect(ciUrl), n);
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
      `${err instanceof UsageError ? err.message : `database error (${errCode(err)})`}; removed the --out file.`
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
    deps.error(`unexpected failure (${errCode(err)})`);
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
