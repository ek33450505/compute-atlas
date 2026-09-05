// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports by Vitest — swaps the real Neon client for a
// lightweight mock so runHeartbeatCheck()'s internal getDb() call never
// touches Neon. Mirrors publish-heartbeat.test.ts's mocking approach: mock
// the drizzle chain directly rather than standing up PGlite, since this
// file is focused on check-heartbeat.ts's own logic (threshold parsing,
// staleness comparison, error selection) rather than exercising a real query.
vi.mock("../../lib/db/client");

import * as dbClient from "../../lib/db/client";
import {
  DISCOVERY_STALE_HOURS_DEFAULT,
  fetchHeartbeatRow,
  HeartbeatMissingError,
  HeartbeatStaleError,
  parseStaleHoursEnv,
  runHeartbeatCheck,
  type HeartbeatFreshnessReport,
} from "./check-heartbeat";
import type { DiscoveryHeartbeatRow } from "../../lib/db/schema";

const NOW = new Date("2026-09-05T12:00:00Z");

function makeRow(overrides: Partial<DiscoveryHeartbeatRow> = {}): DiscoveryHeartbeatRow {
  return {
    id: "singleton",
    lastRunAt: new Date("2026-09-05T00:00:00Z"), // 12h before NOW by default
    status: "ok",
    failureCount: 0,
    states: [],
    updatedAt: new Date("2026-09-05T00:05:00Z"),
    ...overrides,
  };
}

/** Mocks db.select().from().where() to resolve to the given rows. */
function mockSelectResult(rows: DiscoveryHeartbeatRow[]): void {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  vi.mocked(dbClient.getDb).mockReturnValue({ select } as never);
}

beforeEach(() => {
  vi.stubEnv("DISCOVERY_STALE_HOURS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseStaleHoursEnv — pure, no database
// ---------------------------------------------------------------------------

describe("parseStaleHoursEnv", () => {
  it("returns the default (36) when unset", () => {
    expect(parseStaleHoursEnv(undefined)).toBe(DISCOVERY_STALE_HOURS_DEFAULT);
    expect(DISCOVERY_STALE_HOURS_DEFAULT).toBe(36); // must match run.sh's own default
  });

  it("returns the default when set to an empty string", () => {
    expect(parseStaleHoursEnv("")).toBe(DISCOVERY_STALE_HOURS_DEFAULT);
  });

  it("respects a custom numeric threshold", () => {
    expect(parseStaleHoursEnv("12")).toBe(12);
  });

  it("throws — rather than silently falling back — on an unparseable value", () => {
    expect(() => parseStaleHoursEnv("not-a-number")).toThrow(/not a valid positive number/);
  });

  it("throws on a non-positive value", () => {
    expect(() => parseStaleHoursEnv("0")).toThrow(/not a valid positive number/);
    expect(() => parseStaleHoursEnv("-5")).toThrow(/not a valid positive number/);
  });
});

// ---------------------------------------------------------------------------
// fetchHeartbeatRow — mocked DB layer
// ---------------------------------------------------------------------------

describe("fetchHeartbeatRow", () => {
  it("returns the row when present", async () => {
    const row = makeRow();
    mockSelectResult([row]);
    expect(await fetchHeartbeatRow()).toEqual(row);
  });

  it("returns null when no row exists", async () => {
    mockSelectResult([]);
    expect(await fetchHeartbeatRow()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runHeartbeatCheck — the freshness comparison itself
// ---------------------------------------------------------------------------

describe("runHeartbeatCheck", () => {
  it("passes for a fresh, ok row", async () => {
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-05T00:00:00Z"), status: "ok" })]);

    const report: HeartbeatFreshnessReport = await runHeartbeatCheck(36, NOW);

    expect(report.ageHours).toBeCloseTo(12, 5);
    expect(report.thresholdHours).toBe(36);
    expect(report.isDegraded).toBe(false);
  });

  it("passes with isDegraded=true for a fresh row recorded as degraded (still exits 0 at the CLI layer)", async () => {
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-05T00:00:00Z"), status: "degraded" })]);

    const report = await runHeartbeatCheck(36, NOW);

    expect(report.isDegraded).toBe(true);
    // Freshness scope boundary: a degraded-but-fresh row must NOT throw. This
    // check's job is specifically "did it run at all", not run quality.
  });

  it("throws HeartbeatStaleError when last_run_at is older than the threshold", async () => {
    // 48h before NOW, threshold 36h -> stale
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "ok" })]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatStaleError);
  });

  it("HeartbeatStaleError reports the gap in hours and the recorded status", async () => {
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "ok" })]);

    const err = await runHeartbeatCheck(36, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatStaleError);
    expect((err as HeartbeatStaleError).report.ageHours).toBeCloseTo(48, 5);
    expect((err as HeartbeatStaleError).report.thresholdHours).toBe(36);
    expect((err as HeartbeatStaleError).message).toMatch(/48\.0h ago/);
    expect((err as HeartbeatStaleError).message).toMatch(/status="ok"/);
  });

  it("respects a custom threshold: a 40h-old row passes at threshold=48 but fails at threshold=36", async () => {
    const row = makeRow({ lastRunAt: new Date("2026-09-03T20:00:00Z") }); // 40h before NOW
    mockSelectResult([row]);
    await expect(runHeartbeatCheck(48, NOW)).resolves.toMatchObject({ isDegraded: false });

    mockSelectResult([row]);
    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatStaleError);
  });

  it("throws HeartbeatMissingError when no row exists — never treats absence as fine", async () => {
    mockSelectResult([]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatMissingError);
  });
});
