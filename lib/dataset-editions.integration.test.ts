// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetEditionsTable, facilityHistoryTable, type DatasetEditionFile } from "@/lib/db/schema";
import {
  DATASET_EDITION_RETRY_COOLDOWN_MS,
  DATASET_EDITION_STALE_MS,
  claimEdition,
  clearEditionFiles,
  editionsToPrune,
  failEdition,
  failSweptBuild,
  latestPublishedEdition,
  loadHistorySince,
  publishEdition,
  staleBuildsToSweep,
} from "@/lib/dataset-editions";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

const NOW = new Date("2026-11-09T06:00:00.000Z");
const MIN = 60 * 1000;

const file = (editionDate: string, name: string): DatasetEditionFile => ({
  name,
  pathname: `editions/${editionDate}/${name}`,
  bytes: 10,
  sha256: "a".repeat(64),
});

async function seedEdition(
  editionDate: string,
  over: Partial<typeof datasetEditionsTable.$inferInsert> = {}
): Promise<string> {
  const [row] = await tdb.db
    .insert(datasetEditionsTable)
    .values({ editionDate, builtAt: NOW, status: "published", files: [file(editionDate, "facilities.json")], ...over })
    .returning({ id: datasetEditionsTable.id });
  return row.id;
}

const rowOf = async (id: string) =>
  (await tdb.db.select().from(datasetEditionsTable).where(eq(datasetEditionsTable.id, id)))[0];

describe("claimEdition", () => {
  it("inserts a building row stamped with the claim instant", async () => {
    const res = await claimEdition("2026-11-09", NOW);
    expect(res).toMatchObject({ kind: "claimed", reclaimed: false });
    const row = await rowOf((res as { id: string }).id);
    expect(row.status).toBe("building");
    expect(row.builtAt.toISOString()).toBe(NOW.toISOString());
  });

  it("yields exactly one claimed for two concurrent claims of one date", async () => {
    const results = await Promise.all([claimEdition("2026-11-09", NOW), claimEdition("2026-11-09", NOW)]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "inProgress")).toHaveLength(1);
    expect(await tdb.db.select().from(datasetEditionsTable)).toHaveLength(1);
  });

  it("reports a published date as alreadyPublished", async () => {
    const id = await seedEdition("2026-11-09");
    expect(await claimEdition("2026-11-09", NOW)).toEqual({ kind: "alreadyPublished", id });
  });

  it("reports a fresh building row (5 min old) as inProgress and leaves it untouched", async () => {
    const id = await seedEdition("2026-11-09", { status: "building", builtAt: new Date(NOW.getTime() - 5 * MIN) });
    expect(await claimEdition("2026-11-09", NOW)).toEqual({ kind: "inProgress", id });
    expect((await rowOf(id)).builtAt.toISOString()).toBe(new Date(NOW.getTime() - 5 * MIN).toISOString());
  });

  it("reclaims a stale building row (31 min old), resetting its build fields", async () => {
    const id = await seedEdition("2026-11-09", {
      status: "building",
      builtAt: new Date(NOW.getTime() - 31 * MIN),
      recordCount: 5,
      changelogSummary: { added: 1 },
    });
    expect(DATASET_EDITION_STALE_MS).toBe(30 * MIN);
    expect(await claimEdition("2026-11-09", NOW)).toEqual({ kind: "claimed", id, reclaimed: true });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "building", recordCount: null, changelogSummary: null, files: [] });
    expect(row.builtAt.toISOString()).toBe(NOW.toISOString());
  });

  it("reclaims a failed row that failed 6 min ago", async () => {
    const id = await seedEdition("2026-11-09", { status: "failed", builtAt: new Date(NOW.getTime() - 6 * MIN) });
    expect(DATASET_EDITION_RETRY_COOLDOWN_MS).toBe(5 * MIN);
    expect(await claimEdition("2026-11-09", NOW)).toEqual({ kind: "claimed", id, reclaimed: true });
  });

  it("does not reclaim a failed row that failed 2 min ago (retry cooldown) and leaves it untouched", async () => {
    const failedAt = new Date(NOW.getTime() - 2 * MIN);
    const id = await seedEdition("2026-11-09", { status: "failed", builtAt: failedAt });
    expect(await claimEdition("2026-11-09", NOW)).toEqual({ kind: "inProgress", id });
    expect(await rowOf(id)).toMatchObject({ status: "failed" });
    expect((await rowOf(id)).builtAt.toISOString()).toBe(failedAt.toISOString());
  });

  it("ignoreRetryCooldown reclaims a failed row that failed 2 min ago (the weekly cron must not skip a week)", async () => {
    const id = await seedEdition("2026-11-09", { status: "failed", builtAt: new Date(NOW.getTime() - 2 * MIN) });
    expect(await claimEdition("2026-11-09", NOW, { ignoreRetryCooldown: true })).toEqual({
      kind: "claimed",
      id,
      reclaimed: true,
    });
    expect((await rowOf(id)).status).toBe("building");
  });

  it("ignoreRetryCooldown does not shorten the stale-building rule (a 5 min old building row stays inProgress)", async () => {
    const id = await seedEdition("2026-11-09", { status: "building", builtAt: new Date(NOW.getTime() - 5 * MIN) });
    expect(await claimEdition("2026-11-09", NOW, { ignoreRetryCooldown: true })).toEqual({ kind: "inProgress", id });
  });

  it("yields exactly one claimed for two concurrent claims of a stale row", async () => {
    await seedEdition("2026-11-09", { status: "building", builtAt: new Date(NOW.getTime() - 31 * MIN) });
    const results = await Promise.all([claimEdition("2026-11-09", NOW), claimEdition("2026-11-09", NOW)]);
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
  });
});

describe("publishEdition / failEdition", () => {
  const input = (readAt: Date) => ({
    readAt,
    recordCount: 3,
    files: [file("2026-11-09", "facilities.json")],
    changelogSummary: { added: 0, updated: 0, removed: 0, headlines: [] },
  });

  it("publishes a held claim and stamps builtAt with readAt", async () => {
    const claim = (await claimEdition("2026-11-09", NOW)) as { id: string };
    const readAt = new Date(NOW.getTime() + 1000);
    expect(await publishEdition(claim.id, NOW, input(readAt))).toBe(true);
    const row = await rowOf(claim.id);
    expect(row).toMatchObject({ status: "published", recordCount: 3 });
    expect(row.builtAt.toISOString()).toBe(readAt.toISOString());
    expect(row.files).toHaveLength(1);
  });

  it("refuses to publish over a build that was reclaimed by someone else", async () => {
    const claim = (await claimEdition("2026-11-09", NOW)) as { id: string };
    // Another invocation reclaims the stale lease: builtAt moves.
    const reclaimedAt = new Date(NOW.getTime() + 40 * MIN);
    await tdb.db.update(datasetEditionsTable).set({ builtAt: reclaimedAt }).where(eq(datasetEditionsTable.id, claim.id));
    expect(await publishEdition(claim.id, NOW, input(NOW))).toBe(false);
    expect((await rowOf(claim.id)).status).toBe("building");
  });

  it("does not publish a row that is no longer building", async () => {
    const id = await seedEdition("2026-11-09", { status: "failed" });
    expect(await publishEdition(id, NOW, input(NOW))).toBe(false);
  });

  it("failEdition marks only the claim holder's row failed", async () => {
    const claim = (await claimEdition("2026-11-09", NOW)) as { id: string };
    await failEdition(claim.id, new Date(NOW.getTime() - 1));
    expect((await rowOf(claim.id)).status).toBe("building");
    await failEdition(claim.id, NOW);
    expect((await rowOf(claim.id)).status).toBe("failed");
  });

  it("failEdition stamps builtAt with the failure instant, so the retry cooldown measures from it", async () => {
    const claim = (await claimEdition("2026-11-09", NOW)) as { id: string };
    const failedAt = new Date(NOW.getTime() + 4 * MIN);
    await failEdition(claim.id, NOW, [], failedAt);
    expect((await rowOf(claim.id)).builtAt.toISOString()).toBe(failedAt.toISOString());
    // 4 min after the failure is inside the cooldown even though the claim is 8 min old.
    const at = new Date(NOW.getTime() + 8 * MIN);
    expect(await claimEdition("2026-11-09", at)).toEqual({ kind: "inProgress", id: claim.id });
  });

  it("failEdition records the files uploaded before the failure, under the same guard", async () => {
    const claim = (await claimEdition("2026-11-09", NOW)) as { id: string };
    const uploaded = [file("2026-11-09", "facilities.json"), file("2026-11-09", "facilities.csv")];
    await failEdition(claim.id, new Date(NOW.getTime() - 1), uploaded);
    expect((await rowOf(claim.id)).files).toEqual([]);
    await failEdition(claim.id, NOW, uploaded);
    expect(await rowOf(claim.id)).toMatchObject({ status: "failed", files: uploaded });
  });
});

describe("latestPublishedEdition", () => {
  it("returns null before the first edition", async () => {
    expect(await latestPublishedEdition()).toBeNull();
  });

  it("returns the newest published by edition date, ignoring building and failed rows", async () => {
    await seedEdition("2026-11-02");
    const newest = await seedEdition("2026-11-09", { recordCount: 7 });
    await seedEdition("2026-11-16", { status: "failed" });
    await seedEdition("2026-11-23", { status: "building" });
    const latest = await latestPublishedEdition();
    expect(latest).toMatchObject({ id: newest, editionDate: "2026-11-09", recordCount: 7 });
  });
});

describe("loadHistorySince", () => {
  const hist = (facilityId: string, changedAt: Date) => ({
    facilityId,
    changedAt,
    changeType: "update",
    diff: [{ field: "name", before: "A", after: "B" }] as never,
    source: "admin-direct",
  });

  it("never returns the source column", async () => {
    await tdb.db.insert(facilityHistoryTable).values(hist("f1", new Date(NOW.getTime() - MIN)));
    const rows = await loadHistorySince(new Date(NOW.getTime() - 5 * MIN), NOW);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["changeType", "changedAt", "diff", "facilityId"]);
  });

  it("is exclusive at the lower bound and inclusive at the upper", async () => {
    const lower = new Date(NOW.getTime() - 10 * MIN);
    await tdb.db.insert(facilityHistoryTable).values([
      hist("at-lower", lower),
      hist("inside", new Date(lower.getTime() + MIN)),
      hist("at-upper", NOW),
      hist("after-upper", new Date(NOW.getTime() + 1)),
    ]);
    const ids = (await loadHistorySince(lower, NOW)).map((r) => r.facilityId).sort();
    expect(ids).toEqual(["at-upper", "inside"]);
  });

  it("returns [] for a null lower bound without reading the table", async () => {
    await tdb.db.insert(facilityHistoryTable).values(hist("f1", new Date(NOW.getTime() - MIN)));
    expect(await loadHistorySince(null, NOW)).toEqual([]);
  });
});

describe("editionsToPrune / clearEditionFiles", () => {
  const day = (d: number) => `2026-09-${String(d).padStart(2, "0")}`;

  it("returns only published editions outside the newest 8 that still list files", async () => {
    for (let d = 1; d <= 10; d++) await seedEdition(day(d));
    const pruned = await editionsToPrune(8, NOW);
    expect(pruned.map((p) => p.editionDate).sort()).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("skips published rows with no files", async () => {
    await seedEdition("2026-09-01", { files: [] });
    await seedEdition("2026-09-02");
    await seedEdition("2026-09-03");
    expect((await editionsToPrune(1, NOW)).map((p) => p.editionDate)).toEqual(["2026-09-02"]);
  });

  it("never prunes the latest published edition, however many newer failed editions exist", async () => {
    const published = await seedEdition("2026-10-01");
    // Nine newer FAILED editions that listed files (before today): they must not push the published one out.
    for (let d = 2; d <= 10; d++) await seedEdition(`2026-10-${String(d).padStart(2, "0")}`, { status: "failed" });
    const pruned = await editionsToPrune(8, NOW);
    expect(pruned.map((p) => p.id)).not.toContain(published);
    // The failed ones are older than today, so their partial blobs are reclaimed.
    expect(pruned).toHaveLength(9);
    for (const p of pruned) await clearEditionFiles(p.id);
    expect(await editionsToPrune(8, NOW)).toEqual([]);
    expect((await rowOf(published)).files).toHaveLength(1);
  });

  it("does not return today's failed row (a reclaim deletes its prefix itself) or any building row", async () => {
    await seedEdition("2026-11-09", { status: "failed" });
    await seedEdition("2026-11-08", { status: "building" });
    await seedEdition("2026-11-07", { status: "failed" });
    expect((await editionsToPrune(8, NOW)).map((p) => p.editionDate)).toEqual(["2026-11-07"]);
  });

  it("skips failed rows with no files", async () => {
    await seedEdition("2026-11-01", { status: "failed", files: [] });
    expect(await editionsToPrune(8, NOW)).toEqual([]);
  });

  it("clearEditionFiles empties files and keeps the row, so it is not returned again", async () => {
    for (let d = 1; d <= 3; d++) await seedEdition(day(d));
    const [oldest] = await editionsToPrune(2, NOW);
    await clearEditionFiles(oldest.id);
    expect((await rowOf(oldest.id)).files).toEqual([]);
    expect(await editionsToPrune(2, NOW)).toEqual([]);
  });
});

describe("staleBuildsToSweep / failSweptBuild", () => {
  const YESTERDAY_STALE = new Date("2026-11-08T05:00:00.000Z");

  it("returns a building row from an earlier date whose lease is stale", async () => {
    const id = await seedEdition("2026-11-08", { status: "building", builtAt: YESTERDAY_STALE, files: [] });
    expect(await staleBuildsToSweep(NOW)).toEqual([{ id, editionDate: "2026-11-08", builtAt: YESTERDAY_STALE }]);
  });

  it("never returns today's building row, however old its lease", async () => {
    await seedEdition("2026-11-09", { status: "building", builtAt: new Date(NOW.getTime() - 5 * 60 * MIN), files: [] });
    expect(await staleBuildsToSweep(NOW)).toEqual([]);
  });

  it("never returns a young (<30 min) building row from yesterday: a build straddling UTC midnight", async () => {
    const at = new Date("2026-11-09T00:10:00.000Z");
    await seedEdition("2026-11-08", { status: "building", builtAt: new Date("2026-11-08T23:50:00.000Z"), files: [] });
    expect(await staleBuildsToSweep(at)).toEqual([]);
    // ...and the same row IS returned once its lease passes 30 min.
    expect(await staleBuildsToSweep(new Date("2026-11-09T00:21:00.000Z"))).toHaveLength(1);
  });

  it("ignores published and failed rows", async () => {
    await seedEdition("2026-11-06", { builtAt: YESTERDAY_STALE });
    await seedEdition("2026-11-07", { status: "failed", builtAt: YESTERDAY_STALE });
    expect(await staleBuildsToSweep(NOW)).toEqual([]);
  });

  it("failSweptBuild marks the row failed with no files", async () => {
    const id = await seedEdition("2026-11-08", { status: "building", builtAt: YESTERDAY_STALE, files: [] });
    expect(await failSweptBuild(id, YESTERDAY_STALE)).toBe(true);
    expect(await rowOf(id)).toMatchObject({ status: "failed", files: [] });
    expect(await staleBuildsToSweep(NOW)).toEqual([]);
  });

  it("failSweptBuild leaves a row that moved since it was read (guard on status and builtAt)", async () => {
    const id = await seedEdition("2026-11-08", { status: "building", builtAt: YESTERDAY_STALE, files: [] });
    // A live reclaim moved the lease after the sweep read the row.
    await tdb.db.update(datasetEditionsTable).set({ builtAt: NOW }).where(eq(datasetEditionsTable.id, id));
    expect(await failSweptBuild(id, YESTERDAY_STALE)).toBe(false);
    expect((await rowOf(id)).status).toBe("building");

    const pubId = await seedEdition("2026-11-07");
    expect(await failSweptBuild(pubId, NOW)).toBe(false);
    expect((await rowOf(pubId)).status).toBe("published");
  });
});
