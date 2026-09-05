/**
 * Publishes the local discovery pipeline's heartbeat to Neon so an off-machine
 * watchdog (GitHub Actions) can detect "launchd never fired at all" — a
 * failure mode `run.sh` cannot self-detect, since it only runs when it runs.
 * See the `discoveryHeartbeatTable` doc comment in lib/db/schema.ts for the
 * full rationale.
 *
 * Reads discovery-logs/heartbeat.json (written by run.sh after every run) and
 * upserts it into the single `discovery_heartbeat` row (id="singleton").
 *
 * Deliberately fails LOUD, never silent: a publisher that swallows its own
 * errors would recreate the exact "silent instrument" gap this feature exists
 * to close. Any failure (missing file, unparseable JSON, DB error) prints to
 * stderr and exits nonzero.
 *
 * Run via: npm run discovery:heartbeat
 * Dry run (print without writing): npm run discovery:heartbeat -- --dry-run
 *
 * Uses relative imports throughout, matching sibling scripts in this directory.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { getDb } from "../../lib/db/client";
import { discoveryHeartbeatTable } from "../../lib/db/schema";

// --- types -------------------------------------------------------------

/** Shape of a single per-state entry in heartbeat.json's `states` array. */
export interface HeartbeatStateEntry {
  runId: string;
  state: string;
  claudeStatus: string;
  elapsedSecs: number;
}

/** Shape of discovery-logs/heartbeat.json as written by run.sh. */
export interface HeartbeatFile {
  lastRunAt: string;
  status: string; // "ok" | "degraded"
  failureCount: number;
  states: HeartbeatStateEntry[];
}

/** The row shape upserted into discoveryHeartbeatTable. */
export interface HeartbeatUpsertPayload {
  id: "singleton";
  lastRunAt: Date;
  status: string;
  failureCount: number;
  states: HeartbeatStateEntry[];
}

// --- parsing -------------------------------------------------------------

/**
 * Reads and parses the heartbeat file, throwing with a clear message on any
 * failure (missing file, unparseable JSON, or a shape that's missing a
 * required field). Never returns a partial/default payload — the caller must
 * not be able to silently publish garbage.
 */
export function readHeartbeatFile(filePath: string): HeartbeatFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`publish-heartbeat: could not read ${filePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`publish-heartbeat: ${filePath} is not valid JSON: ${(err as Error).message}`);
  }

  const obj = parsed as Partial<HeartbeatFile> | null;
  if (!obj || typeof obj !== "object") {
    throw new Error(`publish-heartbeat: ${filePath} did not parse to an object`);
  }
  if (typeof obj.lastRunAt !== "string") {
    throw new Error(`publish-heartbeat: ${filePath} is missing required field "lastRunAt"`);
  }
  if (typeof obj.status !== "string") {
    throw new Error(`publish-heartbeat: ${filePath} is missing required field "status"`);
  }
  if (typeof obj.failureCount !== "number") {
    throw new Error(`publish-heartbeat: ${filePath} is missing required field "failureCount"`);
  }
  if (!Array.isArray(obj.states)) {
    throw new Error(`publish-heartbeat: ${filePath} is missing required array field "states"`);
  }

  return {
    lastRunAt: obj.lastRunAt,
    status: obj.status,
    failureCount: obj.failureCount,
    states: obj.states as HeartbeatStateEntry[],
  };
}

/** Converts a parsed heartbeat file into the row payload upserted to Neon. */
export function toUpsertPayload(heartbeat: HeartbeatFile): HeartbeatUpsertPayload {
  const lastRunAt = new Date(heartbeat.lastRunAt);
  if (Number.isNaN(lastRunAt.getTime())) {
    throw new Error(`publish-heartbeat: lastRunAt "${heartbeat.lastRunAt}" is not a parseable date`);
  }
  return {
    id: "singleton",
    lastRunAt,
    status: heartbeat.status,
    failureCount: heartbeat.failureCount,
    states: heartbeat.states,
  };
}

// --- publish -------------------------------------------------------------

/**
 * Upserts the heartbeat payload into the single `discovery_heartbeat` row.
 * Throws on any DB error rather than swallowing it — see module doc comment.
 */
export async function publishHeartbeat(payload: HeartbeatUpsertPayload): Promise<void> {
  const db = getDb();
  await db
    .insert(discoveryHeartbeatTable)
    .values(payload)
    .onConflictDoUpdate({
      target: discoveryHeartbeatTable.id,
      set: {
        lastRunAt: payload.lastRunAt,
        status: payload.status,
        failureCount: payload.failureCount,
        states: payload.states,
        updatedAt: new Date(),
      },
    });
}

// --- CLI ---------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.env.DISCOVERY_DRY_RUN === "1";
  const filePath = path.join(process.cwd(), "discovery-logs", "heartbeat.json");

  const heartbeat = readHeartbeatFile(filePath);
  const payload = toUpsertPayload(heartbeat);

  if (dryRun) {
    console.log(`[dry-run] would upsert discovery_heartbeat:`, JSON.stringify(payload, null, 2));
    return;
  }

  await publishHeartbeat(payload);
  console.log(
    `published discovery_heartbeat: status=${payload.status} lastRunAt=${payload.lastRunAt.toISOString()} ` +
      `failureCount=${payload.failureCount} states=${payload.states.length}`,
  );
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
