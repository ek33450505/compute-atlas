// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { stateDigestRunsTable } from "@/lib/db/schema";
import { claimDigestWindow, completeDigestWindow } from "@/lib/state-digest-ledger";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

const since = new Date("2026-08-01T00:00:00Z");
const until = new Date("2026-09-01T00:00:00Z");

describe("claimDigestWindow", () => {
  it("claims an unclaimed window and writes an incomplete row", async () => {
    const claim = await claimDigestWindow(since, until);

    expect(claim).toEqual({ claimed: true });
    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].completedAt).toBeNull();
  });

  it("refuses a second claim for the SAME window and reports the prior run, without inserting a duplicate row", async () => {
    await claimDigestWindow(since, until);

    const second = await claimDigestWindow(since, until);

    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("unreachable");
    expect(second.priorRun.completedAt).toBeNull();
    expect(second.priorRun.recipients).toBeNull();

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1); // still exactly one row — no duplicate insert
  });

  it("distinguishes a COMPLETED prior run from a crashed one via the reported priorRun", async () => {
    await claimDigestWindow(since, until);
    await completeDigestWindow(since, until, { changes: 3, groups: 2, recipients: 2 });

    const second = await claimDigestWindow(since, until);

    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error("unreachable");
    expect(second.priorRun.completedAt).not.toBeNull();
    expect(second.priorRun.recipients).toBe(2);
  });

  it("allows a DIFFERENT window to claim independently", async () => {
    await claimDigestWindow(since, until);

    const otherSince = new Date("2026-09-01T00:00:00Z");
    const otherUntil = new Date("2026-10-01T00:00:00Z");
    const claim = await claimDigestWindow(otherSince, otherUntil);

    expect(claim).toEqual({ claimed: true });
    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(2);
  });

  it("resolves exactly one winner when two claims for the same window race concurrently, and neither throws", async () => {
    const [a, b] = await Promise.all([
      claimDigestWindow(since, until),
      claimDigestWindow(since, until),
    ]);

    const claimedCount = [a, b].filter((r) => r.claimed).length;
    expect(claimedCount).toBe(1);

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1); // exactly one row — the loser never inserted
  });

  it("propagates a non-unique-violation error rather than reporting a claim", async () => {
    // Isolated instance: dropping a table is not something tdb.reset()'s
    // TRUNCATE can undo, and every other test in this file depends on the
    // shared instance keeping state_digest_runs intact (same pattern as
    // scripts/check-schema-drift.test.ts's drop-table test).
    const isolated = await makeTestDb();
    try {
      await isolated.client.exec(`DROP TABLE "state_digest_runs"`);
      vi.mocked(dbClient.getDb).mockReturnValueOnce(isolated.db as never);

      await expect(claimDigestWindow(since, until)).rejects.toThrow();
    } finally {
      await isolated.client.close();
    }
  });
});

describe("completeDigestWindow", () => {
  it("records the completion counts on the claimed row", async () => {
    await claimDigestWindow(since, until);

    await completeDigestWindow(since, until, { changes: 5, groups: 3, recipients: 3 });

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].completedAt).not.toBeNull();
    expect(rows[0].changes).toBe(5);
    expect(rows[0].groups).toBe(3);
    expect(rows[0].recipients).toBe(3);
  });

  it("is a silent no-op when no row matches the window", async () => {
    await expect(
      completeDigestWindow(since, until, { changes: 0, groups: 0, recipients: 0 })
    ).resolves.toBeUndefined();

    const rows = await tdb.db.select().from(stateDigestRunsTable);
    expect(rows).toHaveLength(0);
  });
});
