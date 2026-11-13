/**
 * Environment preflight for the scheduled discovery run.
 *
 * Why this exists: run.sh advances its state-rotation cursor before the batch
 * runs, so an Ollama outage or an unreadable database discovered mid-batch has
 * already consumed the states. This script runs first; a non-zero exit lets
 * run.sh skip the batch without moving the cursor.
 *
 * Checks (all run, none short-circuits; each prints one line):
 *   verify_required  DISCOVERY_REQUIRE_VERIFY=1 with the verification gate off
 *   ollama           the verify model answers (skipped when the gate is off)
 *   facility_read    a one-row read of `facilities` over the pipeline's own path
 *
 * Exit codes (same vocabulary as submit-candidates):
 *   0  every check passed (or was skipped)
 *   1  a CONFIG error: fix .env.local, retrying will not help
 *   3  `EXIT_GATE_UNAVAILABLE`: no config error, but something environmental
 *      failed (Ollama down, database unreachable or empty); retry later
 * Config wins over environmental when both occur.
 *
 * DB errors are reported as a redacted code only (`redactedErrorCode`), never
 * the error object or message. A SQLSTATE in class 28 (auth), 42 (e.g. 42501
 * insufficient privilege, 42P01 undefined table) or 3D (invalid database) is a
 * CONFIG error; every other code, including "unknown" and network codes such as
 * ENOTFOUND, is environmental. A malformed or non-postgres URL is CONFIG too.
 *
 * Zero rows in `facilities` is classed environmental by choice (a cheap retry
 * that leaves the cursor untouched), although it can be config-shaped (the URL
 * points at the wrong database).
 *
 *   npx tsx --env-file=.env.local scripts/discovery/preflight.ts
 */
import { redactedErrorCode } from "../../lib/db-error";
import { facilitiesTable } from "../../lib/db/schema";
import { isEntrypoint } from "../is-entrypoint";
import { getFacilitiesReadDb, resolveReadUrl } from "./load-facilities";
import { probeOllama } from "./ollama-client";
import {
  EXIT_GATE_UNAVAILABLE,
  VERIFY_DISABLED_REFUSAL,
  requireVerifyViolation,
  verificationEnabled,
} from "./submit-candidates";

export const OLLAMA_TIMEOUT_MS = 10_000;
export const FACILITY_READ_TIMEOUT_MS = 15_000;

type EnvLike = Record<string, string | undefined>;

/** Thrown by a `readOneFacility` implementation when the failure is configuration, not environment. */
export class PreflightConfigError extends Error {}

class PreflightTimeoutError extends Error {}

/** SQLSTATE classes that mean the credentials, grants or database name are wrong. */
const CONFIG_SQLSTATE = /^(28|42|3D)[0-9A-Z]{3}$/;

export interface PreflightDeps {
  env: EnvLike;
  fetchImpl: typeof fetch;
  /**
   * Reads at most one facility id. Resolves the row count (0 or 1); resolves
   * null when no database URL is configured. Throws `PreflightConfigError` for
   * a configuration refusal, anything else for a query/network failure.
   */
  readOneFacility: () => Promise<number | null>;
  /** Override for tests; defaults to FACILITY_READ_TIMEOUT_MS. */
  readTimeoutMs?: number;
}

export interface PreflightResult {
  exitCode: number;
  /** Lines in order; `preflight: ok|skip ...` belong on stdout, `preflight: FAIL ...` on stderr. */
  lines: string[];
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PreflightTimeoutError("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const lines: string[] = [];
  let config = false;
  let environmental = false;
  const fail = (check: string, reason: string, kind: "config" | "env") => {
    lines.push(`preflight: FAIL ${check} - ${reason}`);
    if (kind === "config") config = true;
    else environmental = true;
  };

  // 1. verify_required
  if (requireVerifyViolation(deps.env)) fail("verify_required", VERIFY_DISABLED_REFUSAL, "config");
  else lines.push("preflight: ok verify_required");

  // 2. ollama
  if (!verificationEnabled(deps.env)) {
    lines.push("preflight: skip ollama - verification disabled");
  } else {
    const probe = await probeOllama({
      fetchImpl: deps.fetchImpl,
      timeoutMs: OLLAMA_TIMEOUT_MS,
      baseUrl: deps.env.OLLAMA_BASE_URL,
      model: deps.env.OLLAMA_VERIFY_MODEL,
    });
    if (probe.ok) lines.push("preflight: ok ollama");
    else fail("ollama", probe.reason, "env");
  }

  // 3. facility_read
  try {
    const rows = await withTimeout(
      deps.readOneFacility(),
      deps.readTimeoutMs ?? FACILITY_READ_TIMEOUT_MS
    );
    if (rows === null) fail("facility_read", "no database URL configured", "config");
    else if (rows === 0) fail("facility_read", "facilities table empty", "env");
    else lines.push("preflight: ok facility_read");
  } catch (err) {
    if (err instanceof PreflightConfigError) {
      fail("facility_read", "database read refused by configuration (DISCOVERY_REQUIRE_READER)", "config");
    } else if (err instanceof PreflightTimeoutError) {
      fail("facility_read", "timeout", "env");
    } else {
      const code = redactedErrorCode(err);
      fail("facility_read", `query failed (${code})`, CONFIG_SQLSTATE.test(code) ? "config" : "env");
    }
  }

  return { exitCode: config ? 1 : environmental ? EXIT_GATE_UNAVAILABLE : 0, lines };
}

/** The pipeline's own read path: reader-first resolution, one-row select. */
export async function readOneFacilityReal(): Promise<number | null> {
  let resolved: ReturnType<typeof resolveReadUrl>;
  try {
    resolved = resolveReadUrl();
  } catch {
    // resolveReadUrl throws only for DISCOVERY_REQUIRE_READER=1 without a reader URL.
    throw new PreflightConfigError("reader required");
  }
  if (!resolved) return null;
  try {
    const protocol = new URL(resolved.url).protocol;
    if (protocol !== "postgres:" && protocol !== "postgresql:") throw new Error("protocol");
  } catch {
    throw new PreflightConfigError("malformed database URL");
  }
  const handle = getFacilitiesReadDb();
  if (!handle) return null;
  const rows = await handle.db.select({ id: facilitiesTable.id }).from(facilitiesTable).limit(1);
  return rows.length;
}

async function main(): Promise<void> {
  try {
    const { exitCode, lines } = await runPreflight({
      env: process.env,
      fetchImpl: fetch,
      readOneFacility: readOneFacilityReal,
    });
    for (const line of lines) {
      if (line.startsWith("preflight: FAIL")) console.error(line);
      else console.log(line);
    }
    process.exit(exitCode);
  } catch (err) {
    console.error(`preflight: FAIL internal - unexpected error (${redactedErrorCode(err)})`);
    process.exit(1);
  }
}

if (isEntrypoint(import.meta.url)) {
  void main();
}
