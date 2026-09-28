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
  HeartbeatDegradedError,
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
//
// REGRESSION GUARDS (all of them): these pass identically before and after the
// 2026-09-28 degraded-fails change, by design. They pin the two pre-existing
// non-row failure modes the widening was required not to disturb.
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
//
// REGRESSION GUARDS: unaffected by the degraded change; they pin the read.
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
// runHeartbeatCheck — liveness (freshness) AND run quality (status)
// ---------------------------------------------------------------------------

describe("runHeartbeatCheck", () => {
  it("passes for a fresh, ok row", async () => {
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-05T00:00:00Z"), status: "ok" })]);

    const report: HeartbeatFreshnessReport = await runHeartbeatCheck(36, NOW);

    expect(report.ageHours).toBeCloseTo(12, 5);
    expect(report.thresholdHours).toBe(36);
    expect(report.isDegraded).toBe(false);
    // REGRESSION GUARD: passes identically before and after the 2026-09-28
    // change. Kept deliberately — widening the check to fail on status!="ok"
    // must not start failing the healthy case too.
  });

  it("throws HeartbeatDegradedError for a fresh row recorded as degraded", async () => {
    // The 2026-09-26..28 shape exactly: the run happened (fresh) and failed.
    // Before 2026-09-28 this returned a report with isDegraded=true and the
    // CLI printed a ::warning:: and exited 0 — three consecutive real outages
    // were reported as `success` that way.
    mockSelectResult([
      makeRow({
        lastRunAt: new Date("2026-09-05T00:00:00Z"),
        status: "degraded",
        failureCount: 2,
      }),
    ]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatDegradedError);
  });

  it("HeartbeatDegradedError reports the recorded status, failure count and age", async () => {
    mockSelectResult([
      makeRow({
        lastRunAt: new Date("2026-09-05T00:00:00Z"),
        status: "degraded",
        failureCount: 2,
      }),
    ]);

    const err = await runHeartbeatCheck(36, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatDegradedError);
    expect((err as HeartbeatDegradedError).report.isDegraded).toBe(true);
    expect((err as HeartbeatDegradedError).report.ageHours).toBeCloseTo(12, 5);
    expect((err as HeartbeatDegradedError).message).toMatch(/status="degraded"/);
    expect((err as HeartbeatDegradedError).message).toMatch(/failureCount=2/);
    expect((err as HeartbeatDegradedError).message).toMatch(/12\.0h/);
  });

  it("fails on ANY status that is not exactly \"ok\", not just the literal \"degraded\"", async () => {
    // Adversarial value: the rule is `status !== "ok"`, so an unrecognised
    // status must fail closed rather than fall through a two-value match.
    mockSelectResult([
      makeRow({ lastRunAt: new Date("2026-09-05T00:00:00Z"), status: "partial" }),
    ]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatDegradedError);
  });

  it("throws HeartbeatStaleError when last_run_at is older than the threshold", async () => {
    // 48h before NOW, threshold 36h -> stale
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "ok" })]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatStaleError);
    // REGRESSION GUARD: passes before and after. The pre-existing stale
    // failure had to survive the widening unchanged.
  });

  it("HeartbeatStaleError reports the gap in hours and the recorded status", async () => {
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "ok" })]);

    const err = await runHeartbeatCheck(36, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatStaleError);
    expect((err as HeartbeatStaleError).report.ageHours).toBeCloseTo(48, 5);
    expect((err as HeartbeatStaleError).report.thresholdHours).toBe(36);
    expect((err as HeartbeatStaleError).message).toMatch(/48\.0h ago/);
    expect((err as HeartbeatStaleError).message).toMatch(/status="ok"/);
    // REGRESSION GUARD: passes before and after, as above.
  });

  it("keeps 'it never ran' and 'it ran and failed' DISTINGUISHABLE — different types and different remedies", async () => {
    // The two conditions have nothing in common operationally: stale points at
    // the launchd schedule / a sleeping Mac, degraded points at the run's own
    // logs. A reader must be able to tell them apart from the output alone.
    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "ok" })]);
    const staleErr = (await runHeartbeatCheck(36, NOW).catch((e: unknown) => e)) as Error;

    mockSelectResult([makeRow({ lastRunAt: new Date("2026-09-05T00:00:00Z"), status: "degraded" })]);
    const degradedErr = (await runHeartbeatCheck(36, NOW).catch((e: unknown) => e)) as Error;

    expect(staleErr).toBeInstanceOf(HeartbeatStaleError);
    expect(staleErr).not.toBeInstanceOf(HeartbeatDegradedError);
    expect(degradedErr).toBeInstanceOf(HeartbeatDegradedError);
    expect(degradedErr).not.toBeInstanceOf(HeartbeatStaleError);

    expect(staleErr.name).toBe("HeartbeatStaleError");
    expect(degradedErr.name).toBe("HeartbeatDegradedError");
    expect(staleErr.message).not.toBe(degradedErr.message);

    // Each message names its own remedy surface and disclaims the other's.
    expect(staleErr.message).toMatch(/missed entirely/);
    expect(degradedErr.message).toMatch(/NOT a missed run/);
  });

  it("prefers the stale reason when a row is BOTH stale and degraded, but still records isDegraded", async () => {
    // Ordering is deliberate: a stale row's recorded status is itself stale
    // information, and "it stopped running" is the more urgent finding.
    // Nothing is lost — the stale report still carries isDegraded.
    mockSelectResult([
      makeRow({ lastRunAt: new Date("2026-09-03T12:00:00Z"), status: "degraded", failureCount: 3 }),
    ]);

    const err = await runHeartbeatCheck(36, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HeartbeatStaleError);
    expect((err as HeartbeatStaleError).report.isDegraded).toBe(true);
    expect((err as HeartbeatStaleError).message).toMatch(/status="degraded"/);
    // Mutation-sensitive to the ORDER of the two throws (swap them and this
    // fails), not to the presence of the degraded throw.
  });

  it("respects a custom threshold: a 40h-old row passes at threshold=48 but fails at threshold=36", async () => {
    const row = makeRow({ lastRunAt: new Date("2026-09-03T20:00:00Z") }); // 40h before NOW
    mockSelectResult([row]);
    await expect(runHeartbeatCheck(48, NOW)).resolves.toMatchObject({ isDegraded: false });

    mockSelectResult([row]);
    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatStaleError);
    // REGRESSION GUARD: passes before and after.
  });

  it("throws HeartbeatMissingError when no row exists — never treats absence as fine", async () => {
    mockSelectResult([]);

    await expect(runHeartbeatCheck(36, NOW)).rejects.toThrow(HeartbeatMissingError);
    // REGRESSION GUARD: passes before and after.
  });
});
