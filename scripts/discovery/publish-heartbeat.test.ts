// @vitest-environment node
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports by Vitest — swaps the real Neon client for a
// lightweight mock so publishHeartbeat()'s internal getDb() call never
// touches Neon. Mocking the DB layer directly (rather than PGlite) keeps this
// file focused on publish-heartbeat.ts's own logic: parsing, validation, and
// the shape of the upsert it issues.
vi.mock("../../lib/db/client");

import * as dbClient from "../../lib/db/client";
import { discoveryHeartbeatTable } from "../../lib/db/schema";
import {
  publishHeartbeat,
  readHeartbeatFile,
  toUpsertPayload,
  type HeartbeatFile,
} from "./publish-heartbeat";

const VALID_HEARTBEAT: HeartbeatFile = {
  lastRunAt: "2026-09-04T14:51:59-0400",
  status: "ok",
  failureCount: 0,
  states: [
    { runId: "20260904T130005-IA", state: "IA", claudeStatus: "ok", elapsedSecs: 1646 },
    { runId: "20260904T134258-NE", state: "NE", claudeStatus: "ok", elapsedSecs: 1919 },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "publish-heartbeat-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeHeartbeat(content: unknown, filename = "heartbeat.json"): string {
  const filePath = path.join(tmpDir, filename);
  writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content));
  return filePath;
}

// ---------------------------------------------------------------------------
// readHeartbeatFile — pure parsing/validation, no database
// ---------------------------------------------------------------------------

describe("readHeartbeatFile", () => {
  it("parses a valid heartbeat file", () => {
    const filePath = writeHeartbeat(VALID_HEARTBEAT);
    expect(readHeartbeatFile(filePath)).toEqual(VALID_HEARTBEAT);
  });

  it("throws when the file does not exist", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.json");
    expect(() => readHeartbeatFile(missingPath)).toThrow(/could not read/);
  });

  it("throws when the file is not valid JSON", () => {
    const filePath = writeHeartbeat("{ this is not json", "malformed.json");
    expect(() => readHeartbeatFile(filePath)).toThrow(/not valid JSON/);
  });

  it("throws when a required field is missing", () => {
    const filePath = writeHeartbeat({ status: "ok", failureCount: 0, states: [] });
    expect(() => readHeartbeatFile(filePath)).toThrow(/lastRunAt/);
  });

  it("throws when states is not an array", () => {
    const filePath = writeHeartbeat({ lastRunAt: VALID_HEARTBEAT.lastRunAt, status: "ok", failureCount: 0, states: "nope" });
    expect(() => readHeartbeatFile(filePath)).toThrow(/states/);
  });
});

// ---------------------------------------------------------------------------
// toUpsertPayload — pure transform, no database
// ---------------------------------------------------------------------------

describe("toUpsertPayload", () => {
  it("produces the expected upsert payload for a valid heartbeat", () => {
    const payload = toUpsertPayload(VALID_HEARTBEAT);
    expect(payload.id).toBe("singleton");
    expect(payload.lastRunAt).toBeInstanceOf(Date);
    expect(payload.lastRunAt.toISOString()).toBe(new Date(VALID_HEARTBEAT.lastRunAt).toISOString());
    expect(payload.status).toBe("ok");
    expect(payload.failureCount).toBe(0);
    expect(payload.states).toEqual(VALID_HEARTBEAT.states);
  });

  it("throws when lastRunAt is not a parseable date", () => {
    expect(() => toUpsertPayload({ ...VALID_HEARTBEAT, lastRunAt: "not-a-date" })).toThrow(/not a parseable date/);
  });
});

// ---------------------------------------------------------------------------
// publishHeartbeat — mocked DB layer, verifies the upsert shape it issues
// ---------------------------------------------------------------------------

describe("publishHeartbeat", () => {
  it("upserts the singleton row via insert().values().onConflictDoUpdate()", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    vi.mocked(dbClient.getDb).mockReturnValue({ insert } as never);

    const payload = toUpsertPayload(VALID_HEARTBEAT);
    await publishHeartbeat(payload);

    expect(insert).toHaveBeenCalledWith(discoveryHeartbeatTable);
    expect(values).toHaveBeenCalledWith(payload);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const [conflictArgs] = onConflictDoUpdate.mock.calls[0];
    expect(conflictArgs.target).toBe(discoveryHeartbeatTable.id);
    expect(conflictArgs.set.status).toBe(payload.status);
    expect(conflictArgs.set.failureCount).toBe(payload.failureCount);
    expect(conflictArgs.set.states).toEqual(payload.states);
  });

  it("propagates a DB error rather than swallowing it", async () => {
    const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("connection refused"));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    vi.mocked(dbClient.getDb).mockReturnValue({ insert } as never);

    const payload = toUpsertPayload(VALID_HEARTBEAT);
    await expect(publishHeartbeat(payload)).rejects.toThrow("connection refused");
  });
});

// ---------------------------------------------------------------------------
// dry-run — verified at the unit level: readHeartbeatFile + toUpsertPayload
// succeed without any call ever reaching publishHeartbeat/getDb. main()'s own
// --dry-run branch (a thin CLI wrapper) is not otherwise exercised here,
// matching this directory's convention of not testing each script's isMain
// guard (see check-sources.test.ts).
// ---------------------------------------------------------------------------

describe("dry-run path (no DB call)", () => {
  it("computes the same payload a real run would publish, without invoking getDb", () => {
    const filePath = writeHeartbeat(VALID_HEARTBEAT);
    const heartbeat = readHeartbeatFile(filePath);
    const payload = toUpsertPayload(heartbeat);

    expect(payload.id).toBe("singleton");
    expect(dbClient.getDb).not.toHaveBeenCalled();
  });
});
