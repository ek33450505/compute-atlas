/**
 * Loads the live facility set — read Neon directly, JSON file fallback.
 *
 * This was byte-identical duplicated logic across five discovery scripts
 * (submit-candidates.ts, check-sources.ts, existing-facilities.ts,
 * extract-fields.ts, verify-fields.ts). The duplication existed because none
 * of those scripts may import one another — each is an independent CLI
 * entrypoint, and importing across them would create coupling between
 * otherwise-unrelated tools. This module resolves that without violating the
 * constraint: it is a leaf with no dependency on any other
 * scripts/discovery/*.ts file, so every script can import it without
 * creating a script-to-script edge. Do NOT import another
 * scripts/discovery/*.ts file from here — that would reintroduce exactly the
 * coupling this module exists to avoid.
 *
 * The read goes straight to Neon (via DISCOVERY_READ_DATABASE_URL, a read-only
 * role, falling back to DATABASE_URL) rather than `GET /api/facilities`. Since 2026-11-05 a Cloudflare rule blocks
 * that endpoint at the edge (403 before the origin, token or not), so every
 * scheduled run fell back to the frozen data/facilities.json and missed newly
 * approved records, producing duplicate candidates. Reading the DB also stops
 * discovery from sending the owner admin token just to read (security finding
 * M2). Reads only; this module never writes to Neon.
 *
 * The return value carries `source`/`dbError` so a caller can tell whether it
 * got a live read or the data/facilities.json snapshot. That mattered
 * concretely in submit-candidates.ts, where a stale index makes "target not
 * found" indistinguishable from a genuinely-new facility (see its docblock
 * above `exitCodeForSummary`) — the fallback is made observable at the source
 * rather than inferred downstream from a skip-rate.
 *
 * The read is retried (3 attempts, 2 s then 8 s apart, 60 s timeout each) on
 * thrown errors and on an empty result. On 2026-10-14 a single transient
 * failure made submit-candidates.ts discard a 23-minute run's 39 candidates,
 * and a hung connection would otherwise have hung the nightly run forever. On
 * final failure, or with no database URL, it falls back to the JSON snapshot
 * with a stderr WARNING (never stdout: some callers print data there) because
 * that snapshot lacks the newest records. DB errors are logged as a code only
 * (`redactedErrorCode`): Drizzle messages embed bound parameters.
 *
 * Snapshot cache: run.sh invokes these scripts many times per run (once per
 * state for existing-facilities.ts) and each full read is ~6 MB of Neon
 * egress. A successful read is written under ~/.cache/compute-atlas/ (a
 * 0o700 user-owned dir, never the shared tmp dir) and reused for
 * DISCOVERY_FACILITIES_CACHE_TTL_MS (default 30 min; 0 disables). The file
 * name carries a short hash of the database host + name (never the password),
 * so a dev branch never reads the prod snapshot. Writes are exclusive
 * (`wx`, 0o600) then renamed; reads refuse a symlink, a foreign owner or any
 * group/other permission bit, and re-validate the payload with
 * `facilitiesSchema`. The cache is never used to paper over a FAILED read
 * beyond its TTL; a corrupt, unsafe or invalid cache is ignored.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { redactedErrorCode } from "../../lib/db-error";
import * as schema from "../../lib/db/schema";
import { facilitiesTable } from "../../lib/db/schema";
import { rowToFacility } from "../../lib/db/serialize";
import { facilitiesSchema, type Facility } from "../../lib/schema";

export type FacilitySource = "db" | "file";

export type LoadFacilitiesResult = {
  facilities: Facility[];
  source: FacilitySource;
  /** True when source === "db" and the set came from the tmp snapshot cache. */
  cached?: boolean;
  /** Present only when source === "file": why the DB read was abandoned. */
  dbError?: string;
};

export const MAX_ATTEMPTS = 3;
/** Delays slept between attempts 1->2 and 2->3. */
export const RETRY_DELAYS_MS = [2_000, 8_000] as const;
export const ATTEMPT_TIMEOUT_MS = 60_000;
export const DEFAULT_CACHE_TTL_MS = 30 * 60_000;

/** Cache file name for a database URL (reader and owner share one: same host + db): host + database name only, never credentials. */
export function cacheFileNameFor(databaseUrl: string | undefined): string {
  let basis = "unknown";
  try {
    const u = new URL(databaseUrl ?? "");
    basis = `${u.host}${u.pathname}`;
  } catch {
    // unparseable URL: share one "unknown" bucket rather than hashing the raw string
  }
  const hash = createHash("sha256").update(basis).digest("hex").slice(0, 12);
  return `compute-atlas-discovery-facilities-${hash}.json`;
}

export function defaultCacheDir(): string {
  return path.join(os.homedir(), ".cache", "compute-atlas");
}

export type LoadFacilitiesDeps = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Directory holding the snapshot cache; defaults to ~/.cache/compute-atlas. */
  cacheDir?: string;
  /** Per-attempt timeout; defaults to ATTEMPT_TIMEOUT_MS. */
  attemptTimeoutMs?: number;
  readDb?: () => Promise<Facility[]>;
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ReadRole = "reader" | "owner";

let ownerFallbackNoticed = false;

/**
 * The URL for the facility read: the read-only discovery_reader role when
 * DISCOVERY_READ_DATABASE_URL is set, else the owner DATABASE_URL (one stderr
 * notice per process). Null when neither is set. Never logs the URL.
 *
 * DISCOVERY_REQUIRE_READER=1 (set by the scheduled run) is strict mode: there
 * is no owner fallback and no null, it THROWS when the reader URL is unset, so
 * a scheduled read can never use the owner credential. Every caller reaches
 * this outside a try/catch that would swallow it, so the failure stays loud.
 */
export function resolveReadUrl(): { url: string; role: ReadRole } | null {
  const reader = process.env.DISCOVERY_READ_DATABASE_URL;
  if (reader) return { url: reader, role: "reader" };
  if (process.env.DISCOVERY_REQUIRE_READER === "1") {
    throw new Error(
      "DISCOVERY_READ_DATABASE_URL is required when DISCOVERY_REQUIRE_READER=1; refusing the owner credential"
    );
  }
  const owner = process.env.DATABASE_URL;
  if (!owner) return null;
  if (!ownerFallbackNoticed) {
    ownerFallbackNoticed = true;
    console.error(
      "NOTICE: DISCOVERY_READ_DATABASE_URL is not set; reading with DATABASE_URL (owner). " +
        "Set the read-only URL (see docs/discovery-runbook.md)."
    );
  }
  return { url: owner, role: "owner" };
}

// Built here, not in lib/db/client.ts, which the app and the write scripts share.
const clients = new Map<string, ReturnType<typeof drizzle<typeof schema>>>();

function dbFor(url: string) {
  let db = clients.get(url);
  if (!db) {
    db = drizzle(neon(url), { schema });
    clients.set(url, db);
  }
  return db;
}

/**
 * The memoized facilities-read client, for callers that need a query of their
 * own (leads-lane's duplicate check). Null when neither URL is set. Same
 * reader-first resolution, and NOTICE, as loadFacilities().
 */
export function getFacilitiesReadDb(): { db: ReturnType<typeof dbFor>; role: ReadRole } | null {
  const resolved = resolveReadUrl();
  return resolved ? { db: dbFor(resolved.url), role: resolved.role } : null;
}

async function readDbFacilities(url: string): Promise<Facility[]> {
  const rows = await dbFor(url).select({ doc: facilitiesTable.doc }).from(facilitiesTable);
  return rows.map(rowToFacility);
}

function cacheTtlMs(): number {
  const raw = process.env.DISCOVERY_FACILITIES_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(
      `WARNING: DISCOVERY_FACILITIES_CACHE_TTL_MS="${raw}" is not a non-negative number; using the default ${DEFAULT_CACHE_TTL_MS} ms.`
    );
    return DEFAULT_CACHE_TTL_MS;
  }
  return n;
}

const ownerOnly = (st: { uid: number; mode: number }): boolean =>
  (process.getuid === undefined || st.uid === process.getuid()) && (st.mode & 0o077) === 0;

/** Creates the cache dir at 0o700; returns false (caching skipped) if it cannot be made private. */
function ensureCacheDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid())) {
      return false;
    }
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    return ownerOnly(lstatSync(dir));
  } catch {
    return false;
  }
}

function readCache(file: string, ttl: number, nowMs: number): Facility[] | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || !ownerOnly(st)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      fetchedAt?: unknown;
      facilities?: unknown;
    };
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.facilities)) return null;
    if (parsed.facilities.length === 0) return null;
    const age = nowMs - parsed.fetchedAt;
    if (age < 0 || age >= ttl) return null;
    if (!facilitiesSchema.safeParse(parsed.facilities).success) return null;
    return parsed.facilities as Facility[];
  } catch {
    return null;
  }
}

function writeCache(file: string, nowMs: number, facilities: Facility[]): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ fetchedAt: nowMs, facilities }), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Best effort: a cache that cannot be written only costs egress.
    try {
      unlinkSync(tmp);
    } catch {
      // tmp was never created or is already gone
    }
  }
}

async function attemptOnce(readDb: () => Promise<Facility[]>, timeoutMs: number): Promise<Facility[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    const facilities = await Promise.race([readDb(), timeout]);
    if (!Array.isArray(facilities) || facilities.length === 0) {
      throw new Error("empty result");
    }
    return facilities;
  } finally {
    clearTimeout(timer);
  }
}

/** A snapshot smaller than this is a test fixture or a truncated write, never the real set. */
const MIN_SNAPSHOT_RECORDS = 1000;

const LOCAL_ONLY_NOTE = "a db:export refresh is local only; do not commit it while data/facilities.json is tracked";

/** Fix hint; the Neon-restore advice applies only on the fallback path (a dbError means Neon was tried). */
function snapshotFix(dbError?: string): string {
  const refresh = `\`npm run db:export\` (needs Neon access) refreshes the local data/facilities.json snapshot (${LOCAL_ONLY_NOTE})`;
  return dbError
    ? `Restore Neon access (DISCOVERY_READ_DATABASE_URL / DATABASE_URL); once Neon is reachable, ${refresh}.`
    : `${refresh[0].toUpperCase()}${refresh.slice(1)}.`;
}

function refuseSnapshot(reason: string, dbError?: string): never {
  const neon = dbError ? ` (Neon read failed: ${dbError})` : "";
  throw new Error(
    `discovery refuses to dedupe against an incomplete facility snapshot: ${reason}${neon}. ${snapshotFix(dbError)}`
  );
}

function readSnapshotJson(file: string, label: string, dbError?: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return refuseSnapshot(`${label} is missing or unreadable`, dbError);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return refuseSnapshot(`${label} is not valid JSON`, dbError);
  }
}

/**
 * Whether the size floor is waived. DISCOVERY_ALLOW_SMALL_SNAPSHOT=1 is honoured
 * ONLY under Vitest (which sets VITEST), where tests run against the 68-record
 * fixture. Outside Vitest a stray value, e.g. in .env.local, is ignored with a
 * stderr note so it can never weaken a real run.
 */
function smallSnapshotAllowed(): boolean {
  if (process.env.DISCOVERY_ALLOW_SMALL_SNAPSHOT !== "1") return false;
  if (process.env.VITEST) return true;
  console.error("NOTICE: DISCOVERY_ALLOW_SMALL_SNAPSHOT is only honoured under Vitest; ignoring it.");
  return false;
}

/**
 * Guarded read of `<rootDir>/data/facilities.json`, the committed snapshot.
 * Throws unless it is a non-empty array, its facilities.meta.json is readable
 * with a numeric `recordCount` equal to the array length, every record passes
 * `facilitiesSchema`, and the count is at least MIN_SNAPSHOT_RECORDS (waived
 * only per `smallSnapshotAllowed`). Exported for sync callers that must NOT
 * read Neon (the bench target builder, whose ground truth must be reproducible).
 */
export function readFacilitiesSnapshot(
  rootDir: string,
  dbError?: string
): { facilities: Facility[]; asOf: string } {
  const dataDir = path.join(rootDir, "data");
  const parsed = readSnapshotJson(path.join(dataDir, "facilities.json"), "data/facilities.json", dbError);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    refuseSnapshot("data/facilities.json is not a non-empty array", dbError);
  }
  const meta = readSnapshotJson(path.join(dataDir, "facilities.meta.json"), "data/facilities.meta.json", dbError);
  const metaObj = meta as { asOf?: unknown; recordCount?: unknown } | null;
  const recordCount = metaObj?.recordCount;
  if (typeof recordCount !== "number") {
    refuseSnapshot("data/facilities.meta.json has no numeric recordCount", dbError);
  }
  if (recordCount !== parsed.length) {
    refuseSnapshot(
      `data/facilities.meta.json says ${recordCount} records but data/facilities.json holds ${parsed.length}`,
      dbError
    );
  }
  if (parsed.length < MIN_SNAPSHOT_RECORDS && !smallSnapshotAllowed()) {
    refuseSnapshot(`data/facilities.json holds only ${parsed.length} records (floor ${MIN_SNAPSHOT_RECORDS})`, dbError);
  }
  const valid = facilitiesSchema.safeParse(parsed);
  if (!valid.success) refuseSnapshot("data/facilities.json fails schema validation", dbError);
  const asOf = typeof metaObj?.asOf === "string" ? metaObj.asOf : "unknown";
  return { facilities: parsed as Facility[], asOf };
}

function loadFile(dbError: string): LoadFacilitiesResult {
  const { facilities, asOf } = readFacilitiesSnapshot(process.cwd(), dbError);
  console.error(
    `WARNING: could not read the live facility set from Neon (${dbError}). ` +
      `Falling back to data/facilities.json (${facilities.length} records, as of ${asOf}), ` +
      "which lacks the newest records, so candidates may duplicate existing facilities."
  );
  return { facilities, source: "file", dbError };
}

export async function loadFacilities(deps: LoadFacilitiesDeps = {}): Promise<LoadFacilitiesResult> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  const resolved = resolveReadUrl();
  if (!resolved) return loadFile("neither DISCOVERY_READ_DATABASE_URL nor DATABASE_URL is set");
  const { url: readUrl, role } = resolved;
  const readDb = deps.readDb ?? (() => readDbFacilities(readUrl));

  const ttl = cacheTtlMs();
  const cacheDir = deps.cacheDir ?? defaultCacheDir();
  const cacheFile = path.join(cacheDir, cacheFileNameFor(readUrl));
  const useCache = ttl > 0 && ensureCacheDir(cacheDir);
  if (useCache) {
    const hit = readCache(cacheFile, ttl, now());
    if (hit) {
      console.error(`facilities: ${hit.length} from db (${role}) (cached)`);
      return { facilities: hit, source: "db", cached: true };
    }
  }

  let dbError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const facilities = await attemptOnce(readDb, deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
      if (useCache) writeCache(cacheFile, now(), facilities);
      console.error(`facilities: ${facilities.length} from db (${role})`);
      return { facilities, source: "db", cached: false };
    } catch (err) {
      const code = err instanceof Error && err.message === "timeout" ? "timeout"
        : err instanceof Error && err.message === "empty result" ? "empty result"
        : redactedErrorCode(err);
      dbError = `${attempt} attempts; last: ${code}`;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  return loadFile(dbError);
}
