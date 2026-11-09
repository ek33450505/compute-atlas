// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");
vi.mock("@/lib/dataset-blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dataset-blob")>()),
  putEditionFile: vi.fn(),
  deleteEditionPrefix: vi.fn(),
}));
vi.mock("@/lib/dataset-grants", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dataset-grants")>();
  return { ...original, expireDueGrants: vi.fn(original.expireDueGrants) };
});

import * as dbClient from "@/lib/db/client";
import { DATASET_EDITION_FILES, DatasetBlobError, deleteEditionPrefix, putEditionFile } from "@/lib/dataset-blob";
import { expireDueGrants } from "@/lib/dataset-grants";
import { buildEdition } from "@/lib/dataset-edition-builder";
import { latestPublishedEdition } from "@/lib/dataset-editions";
import type { SnapshotSource } from "@/lib/dataset-snapshot";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetEditionsTable, facilityHistoryTable } from "@/lib/db/schema";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

afterAll(async () => {
  await tdb.client.close();
});

// A small valid fixture (same shape the snapshot tests use) with floors lowered to match.
const src = (url: string) => ({ url, label: "Source", retrievedAt: "2026-11-01" });
const FACILITIES = [
  {
    id: "zeta-dc",
    name: "Zeta Campus",
    operator: "Zeta Corp",
    facilityType: "data_center",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 40.1, lon: -97.5, state: "NE", city: "Omaha" },
    capacityMw: { operational: 120 },
    sources: [src("https://example.com/zeta")],
    lastUpdated: "2026-11-01",
  },
  {
    id: "alpha-mine",
    name: "Alpha Mining",
    operator: "Alpha Corp",
    facilityType: "crypto_mining",
    status: "proposed",
    confidence: "reported",
    location: { lat: 31.2, lon: -99.1, state: "TX" },
    sources: [src("https://example.com/alpha")],
    lastUpdated: "2026-10-15",
  },
];
const owner = (name: string) => ({
  name,
  kind: "organization",
  role: "controlling_owner",
  source: src("https://example.com/own"),
  asOf: "2026-11-01",
});
const floors = { facilities: 1, siting: 1, ownership: 1 };
const makeSource = (): SnapshotSource => ({
  facilities: async () => FACILITIES.map((doc) => ({ doc })) as never,
  sitingContext: async () => [{ facilityId: "zeta-dc", data: { waterStress: { cat: 2, label: "Medium" } } }],
  operatorOwnership: async () => [{ data: { operator: "Zeta Corp", owners: [owner("Zeta Holdings")] } }],
});

const NOW = new Date("2026-11-09T06:00:00.000Z");
const MIN = 60 * 1000;
const FILE_NAMES = [...DATASET_EDITION_FILES];

let puts: Array<{ date: string; name: string; body: string }>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await tdb.reset();
  puts = [];
  vi.mocked(putEditionFile).mockReset();
  vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
    puts.push({ date, name, body });
    return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
  });
  vi.mocked(deleteEditionPrefix).mockReset();
  vi.mocked(deleteEditionPrefix).mockResolvedValue(0);
  vi.mocked(expireDueGrants).mockClear();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

const allEditions = () => tdb.db.select().from(datasetEditionsTable);
const bodyOf = (name: string, date = "2026-11-09") => puts.find((p) => p.date === date && p.name === name)!.body;

describe("buildEdition happy path", () => {
  it("publishes a row with five files, a summary, recordCount, and builtAt == the snapshot readAt", async () => {
    const before = Date.now();
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res).toMatchObject({ outcome: "published", editionDate: "2026-11-09", recordCount: 2 });

    const [row] = await allEditions();
    expect(row).toMatchObject({ status: "published", recordCount: 2, editionDate: "2026-11-09" });
    expect(row.files.map((f) => f.name)).toEqual(FILE_NAMES);
    expect(row.files[0]).toEqual({
      name: "facilities.json",
      pathname: "editions/2026-11-09/facilities.json",
      bytes: Buffer.byteLength(bodyOf("facilities.json")),
      sha256: "b".repeat(64),
    });
    expect(row.changelogSummary).toEqual({ added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 2 records"] });

    // builtAt is the readAt taken inside the build, not the claim's `now`.
    expect(row.builtAt.getTime()).toBeGreaterThanOrEqual(before);
    const changelog = JSON.parse(bodyOf("changelog.json"));
    expect(changelog.editionWindow.to).toBe(row.builtAt.toISOString());
    expect(puts.map((p) => p.name)).toEqual(FILE_NAMES);
  });

  it("the first edition is the initial one: changelog and README say so", async () => {
    await buildEdition({ now: NOW, source: makeSource(), floors });
    const changelog = JSON.parse(bodyOf("changelog.json"));
    expect(changelog).toMatchObject({ initial: true, recordCount: 2 });
    expect(changelog.editionWindow.from).toBeNull();
    const [row] = await allEditions();
    expect(bodyOf("README.txt")).toContain(row.id);
  });

  it("ships facilities.json and siting-context.json as db:export writes them, and a CSV", async () => {
    await buildEdition({ now: NOW, source: makeSource(), floors });
    const facilities = JSON.parse(bodyOf("facilities.json"));
    expect(facilities.map((f: { id: string }) => f.id)).toEqual(["alpha-mine", "zeta-dc"]);
    expect(bodyOf("facilities.json").endsWith("]\n")).toBe(true);
    expect(JSON.parse(bodyOf("siting-context.json"))).toEqual({
      "zeta-dc": { waterStress: { cat: 2, label: "Medium" } },
    });
    expect(bodyOf("facilities.csv")).toContain("Zeta Campus");
    expect(bodyOf("changelog.json").endsWith("\n")).toBe(true);
  });

  it("the next edition's window starts at the previous builtAt, counting each history row once", async () => {
    await buildEdition({ now: NOW, source: makeSource(), floors });
    const first = (await latestPublishedEdition())!;

    // Make the first edition's snapshot instant deterministic, then add boundary history rows.
    const firstBuiltAt = new Date(Date.now() - 2 * 24 * 60 * MIN);
    await tdb.db.update(datasetEditionsTable).set({ builtAt: firstBuiltAt }).where(eq(datasetEditionsTable.id, first.id));
    const hist = (facilityId: string, changedAt: Date, changeType: string, diff: unknown) => ({
      facilityId,
      changedAt,
      changeType,
      diff: diff as never,
      source: "admin-direct",
    });
    await tdb.db.insert(facilityHistoryTable).values([
      // exactly at the previous snapshot instant: belongs to the previous edition
      hist("zeta-dc", firstBuiltAt, "update", [{ field: "name", before: "x", after: "Zeta Campus" }]),
      // after it: belongs to this one
      hist("alpha-mine", new Date(firstBuiltAt.getTime() + MIN), "update", [
        { field: "status", before: "planned", after: "proposed" },
      ]),
    ]);

    puts = [];
    const second = await buildEdition({ now: new Date(NOW.getTime() + 24 * 60 * MIN), source: makeSource(), floors });
    expect(second.outcome).toBe("published");
    const changelog = JSON.parse(bodyOf("changelog.json", "2026-11-10"));
    expect(changelog.initial).toBe(false);
    expect(changelog.editionWindow.from).toBe(firstBuiltAt.toISOString());
    expect(changelog.updated.map((e: { id: string }) => e.id)).toEqual(["alpha-mine"]);
    expect(JSON.stringify(changelog)).not.toContain("admin-direct");
  });
});

describe("buildEdition snapshot window", () => {
  it("history written during the read falls outside this edition's window and inside the next one's", async () => {
    // A previous published edition so the first window below is a real one, not the initial edition.
    await tdb.db.insert(datasetEditionsTable).values({
      editionDate: "2026-11-02",
      builtAt: new Date(Date.now() - 2 * 24 * 60 * MIN),
      status: "published",
      files: [{ name: "facilities.json", pathname: "editions/2026-11-02/facilities.json", bytes: 1, sha256: "c".repeat(64) }],
    });

    const source: SnapshotSource = {
      ...makeSource(),
      facilities: async () => {
        // Strictly after readAt (taken before the reads), so it cannot tie with the window's upper bound.
        await new Promise((r) => setTimeout(r, 10));
        await tdb.db.insert(facilityHistoryTable).values({
          facilityId: "alpha-mine",
          changedAt: new Date(),
          changeType: "update",
          diff: [{ field: "status", before: "planned", after: "proposed" }] as never,
          source: "admin-direct",
        });
        return FACILITIES.map((doc) => ({ doc })) as never;
      },
    };

    expect((await buildEdition({ now: NOW, source, floors })).outcome).toBe("published");
    const first = JSON.parse(bodyOf("changelog.json", "2026-11-09"));
    expect(first.initial).toBe(false);
    expect(first.updated).toEqual([]);

    puts = [];
    const second = await buildEdition({ now: new Date(NOW.getTime() + 24 * 60 * MIN), source: makeSource(), floors });
    expect(second.outcome).toBe("published");
    const next = JSON.parse(bodyOf("changelog.json", "2026-11-10"));
    expect(next.updated.map((e: { id: string }) => e.id)).toEqual(["alpha-mine"]);
  });

  it("rolls the edition date at UTC midnight: 23:59:59.999Z and 00:00:00.000Z are different editions", async () => {
    const before = await buildEdition({ now: new Date("2026-11-09T23:59:59.999Z"), source: makeSource(), floors });
    const after = await buildEdition({ now: new Date("2026-11-10T00:00:00.000Z"), source: makeSource(), floors });
    expect(before).toMatchObject({ outcome: "published", editionDate: "2026-11-09" });
    expect(after).toMatchObject({ outcome: "published", editionDate: "2026-11-10" });
    expect((await allEditions()).map((r) => r.editionDate).sort()).toEqual(["2026-11-09", "2026-11-10"]);
  });
});

describe("buildEdition failures", () => {
  async function seedPublished(date: string) {
    const first = await buildEdition({ now: new Date(`${date}T06:00:00.000Z`), source: makeSource(), floors });
    expect(first.outcome).toBe("published");
  }

  it("a failed upload leaves a failed row and the previous edition still latest", async () => {
    await seedPublished("2026-11-02");
    const previous = (await latestPublishedEdition())!;

    let calls = 0;
    vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
      if (++calls === 3) throw new DatasetBlobError("blob_put_failed");
      return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
    });

    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res).toMatchObject({ outcome: "failed", editionDate: "2026-11-09", code: "blob_put_failed" });
    const row = (await allEditions()).find((r) => r.editionDate === "2026-11-09")!;
    expect(row.status).toBe("failed");
    // The two files uploaded before the third put threw are recorded so a later prune can delete them.
    expect(row.files.map((f) => f.name)).toEqual(FILE_NAMES.slice(0, 2));
    expect(await latestPublishedEdition()).toMatchObject({ id: previous.id, editionDate: "2026-11-02" });
    expect(errorSpy).toHaveBeenCalledWith("dataset edition: upload failed (code: blob_put_failed)");
  });

  it("a below-floor source fails with below_floor, uploads nothing, previous edition still latest", async () => {
    await seedPublished("2026-11-02");
    puts = [];
    const res = await buildEdition({
      now: NOW,
      source: makeSource(),
      floors: { facilities: 2900, siting: 1, ownership: 1 },
    });
    expect(res).toMatchObject({ outcome: "failed", code: "below_floor" });
    expect(puts).toEqual([]);
    expect((await allEditions()).find((r) => r.editionDate === "2026-11-09")!.status).toBe("failed");
    expect((await latestPublishedEdition())!.editionDate).toBe("2026-11-02");
  });

  it("losing the claim before publish yields claim_lost and does not overwrite the new claim", async () => {
    // The last upload is when another invocation "reclaims" the lease: its builtAt moves.
    vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
      if (name === "README.txt") {
        await tdb.db
          .update(datasetEditionsTable)
          .set({ builtAt: new Date(NOW.getTime() + 40 * MIN) })
          .where(eq(datasetEditionsTable.editionDate, date));
      }
      return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
    });
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res).toMatchObject({ outcome: "failed", code: "claim_lost" });
    const [row] = await allEditions();
    expect(row.status).toBe("building");
    expect(row.files).toEqual([]);
    expect(expireDueGrants).not.toHaveBeenCalled();
  });

  it("never throws: a raw source error becomes failed, and only the code is logged", async () => {
    const source: SnapshotSource = {
      ...makeSource(),
      facilities: async () => {
        throw new Error("secret-token-abc leaked in message");
      },
    };
    const res = await buildEdition({ now: NOW, source, floors });
    expect(res).toMatchObject({ outcome: "failed", code: "unknown" });
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toBe("dataset edition: snapshot failed (code: unknown)");
    expect(logged).not.toContain("secret-token-abc");
    expect((await allEditions())[0].status).toBe("failed");
  });
});

describe("buildEdition claim states", () => {
  it("a second invocation on the same day returns alreadyPublished and uploads nothing", async () => {
    const first = await buildEdition({ now: NOW, source: makeSource(), floors });
    puts = [];
    const second = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(second).toMatchObject({ outcome: "alreadyPublished", editionDate: "2026-11-09" });
    expect((second as { editionId: string }).editionId).toBe((first as { editionId: string }).editionId);
    expect(puts).toEqual([]);
    expect(await allEditions()).toHaveLength(1);
  });

  it("a fresh building row (5 min) is inProgress and nothing is uploaded", async () => {
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-09", builtAt: new Date(NOW.getTime() - 5 * MIN), status: "building" });
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res).toMatchObject({ outcome: "inProgress", editionDate: "2026-11-09" });
    expect(puts).toEqual([]);
    expect(deleteEditionPrefix).not.toHaveBeenCalled();
  });

  it("a stale building row (31 min) is reclaimed: the prefix is deleted BEFORE any upload", async () => {
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-09", builtAt: new Date(NOW.getTime() - 31 * MIN), status: "building" });
    const order: string[] = [];
    vi.mocked(deleteEditionPrefix).mockImplementation(async (date) => {
      order.push(`delete:${date}`);
      return 2;
    });
    vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
      order.push(`put:${name}`);
      return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
    });
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res.outcome).toBe("published");
    expect(order[0]).toBe("delete:2026-11-09");
    expect(order.slice(1, 6)).toEqual(FILE_NAMES.map((n) => `put:${n}`));
  });

  it("a failed row older than the retry cooldown (6 min) is retried the same day", async () => {
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-09", builtAt: new Date(NOW.getTime() - 6 * MIN), status: "failed" });
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res.outcome).toBe("published");
    expect(await allEditions()).toHaveLength(1);
  });

  it("a failed row inside the retry cooldown (2 min) is inProgress and Neon is never read", async () => {
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-09", builtAt: new Date(NOW.getTime() - 2 * MIN), status: "failed" });
    const source = makeSource();
    const facilitiesSpy = vi.spyOn(source, "facilities");
    const res = await buildEdition({ now: NOW, source, floors });
    expect(res).toMatchObject({ outcome: "inProgress", editionDate: "2026-11-09" });
    expect(facilitiesSpy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(deleteEditionPrefix).not.toHaveBeenCalled();
    expect((await allEditions())[0].status).toBe("failed");
  });

  it("ignoreRetryCooldown retries a failed row that failed 2 min ago; the default keeps the cooldown", async () => {
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-09", builtAt: new Date(NOW.getTime() - 2 * MIN), status: "failed" });
    expect((await buildEdition({ now: NOW, source: makeSource(), floors })).outcome).toBe("inProgress");
    const res = await buildEdition({ now: NOW, source: makeSource(), floors, ignoreRetryCooldown: true });
    expect(res.outcome).toBe("published");
  });
});

describe("buildEdition post-publish", () => {
  it("expires due grants after publishing, and a failure there does not change the outcome", async () => {
    vi.mocked(expireDueGrants).mockRejectedValueOnce(new Error("boom with params"));
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res.outcome).toBe("published");
    expect(expireDueGrants).toHaveBeenCalledTimes(1);
    expect(expireDueGrants).toHaveBeenCalledWith(NOW);
    expect(errorSpy).toHaveBeenCalledWith("dataset edition: expire_grants failed (code: unknown)");
    expect((await allEditions())[0].status).toBe("published");
  });

  it("does not expire grants when the build fails", async () => {
    vi.mocked(putEditionFile).mockRejectedValue(new DatasetBlobError("blob_put_failed"));
    await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(expireDueGrants).not.toHaveBeenCalled();
  });

  it("a failed publish skips all maintenance: no prune, no stale-build sweep, no grant expiry", async () => {
    // A build killed yesterday: the sweep would delete its prefix if maintenance ran.
    await tdb.db
      .insert(datasetEditionsTable)
      .values({ editionDate: "2026-11-08", builtAt: new Date(NOW.getTime() - 40 * MIN), status: "building" });
    vi.mocked(putEditionFile).mockRejectedValue(new DatasetBlobError("blob_put_failed"));
    expect((await buildEdition({ now: NOW, source: makeSource(), floors })).outcome).toBe("failed");
    expect(deleteEditionPrefix).not.toHaveBeenCalled();
    expect(expireDueGrants).not.toHaveBeenCalled();
    const yesterday = (await allEditions()).find((r) => r.editionDate === "2026-11-08")!;
    expect(yesterday.status).toBe("building");
  });

  it("a failed build's partial uploads are pruned once the failed edition is older than today", async () => {
    vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
      if (name === "facilities.csv") throw new DatasetBlobError("blob_put_failed");
      return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
    });
    expect((await buildEdition({ now: NOW, source: makeSource(), floors })).outcome).toBe("failed");
    expect((await allEditions())[0].files).toHaveLength(1);

    // The next day's publish prunes: the failed row is now older than today, so its prefix goes.
    vi.mocked(putEditionFile).mockImplementation(async (date, name, body) => {
      return { pathname: `editions/${date}/${name}`, bytes: Buffer.byteLength(body), sha256: "b".repeat(64) };
    });
    const next = new Date(NOW.getTime() + 24 * 60 * MIN);
    vi.mocked(deleteEditionPrefix).mockClear();
    expect((await buildEdition({ now: next, source: makeSource(), floors })).outcome).toBe("published");
    expect(vi.mocked(deleteEditionPrefix).mock.calls.map(([d]) => d)).toEqual(["2026-11-09"]);
    const failed = (await allEditions()).find((r) => r.editionDate === "2026-11-09")!;
    expect(failed).toMatchObject({ status: "failed", files: [] });
  });

  describe("sweeping builds killed at maxDuration", () => {
    const seedBuilding = (editionDate: string, builtAt: Date) =>
      tdb.db.insert(datasetEditionsTable).values({ editionDate, builtAt, status: "building" });
    const rowOn = async (date: string) => (await allEditions()).find((r) => r.editionDate === date)!;

    it("deletes yesterday's stale building row's prefix and marks it failed with no files", async () => {
      await seedBuilding("2026-11-08", new Date("2026-11-08T05:00:00.000Z"));
      const res = await buildEdition({ now: NOW, source: makeSource(), floors });
      expect(res.outcome).toBe("published");
      expect(vi.mocked(deleteEditionPrefix).mock.calls.map(([d]) => d)).toEqual(["2026-11-08"]);
      expect(await rowOn("2026-11-08")).toMatchObject({ status: "failed", files: [] });
    });

    it("leaves a building row from yesterday whose lease is still fresh (clock edge)", async () => {
      await seedBuilding("2026-11-08", new Date(NOW.getTime() - 10 * MIN));
      await buildEdition({ now: NOW, source: makeSource(), floors });
      expect(deleteEditionPrefix).not.toHaveBeenCalled();
      expect((await rowOn("2026-11-08")).status).toBe("building");
    });

    it("never touches a building row dated today or later", async () => {
      await seedBuilding("2026-11-10", new Date(NOW.getTime() - 5 * 60 * MIN));
      await buildEdition({ now: NOW, source: makeSource(), floors });
      expect(deleteEditionPrefix).not.toHaveBeenCalled();
      expect((await rowOn("2026-11-10")).status).toBe("building");
    });

    it("a sweep delete failure is logged, never fatal, and leaves the row building so the next run retries", async () => {
      await seedBuilding("2026-11-08", new Date("2026-11-08T05:00:00.000Z"));
      vi.mocked(deleteEditionPrefix).mockRejectedValue(new DatasetBlobError("blob_delete_failed"));
      const res = await buildEdition({ now: NOW, source: makeSource(), floors });
      expect(res.outcome).toBe("published");
      expect(errorSpy).toHaveBeenCalledWith("dataset edition: sweep failed (code: blob_delete_failed)");
      expect((await rowOn("2026-11-08")).status).toBe("building");
    });
  });

  async function seedTen() {
    const file = (d: string) => [{ name: "facilities.json", pathname: `editions/${d}/facilities.json`, bytes: 1, sha256: "c".repeat(64) }];
    // 10 published older editions; with today's build that is 11, so 3 fall outside the newest 8.
    for (let d = 1; d <= 10; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      await tdb.db
        .insert(datasetEditionsTable)
        .values({ editionDate: date, builtAt: new Date(`${date}T06:00:00Z`), status: "published", files: file(date) });
    }
  }

  it("prunes blobs of editions outside the newest 8, keeps the rows, and a second run deletes nothing", async () => {
    await seedTen();
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res.outcome).toBe("published");

    const deleted = vi.mocked(deleteEditionPrefix).mock.calls.map(([d]) => d).sort();
    expect(deleted).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);

    const rows = await allEditions();
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      const pruned = deleted.includes(row.editionDate);
      expect(row.files.length > 0).toBe(!pruned);
    }

    vi.mocked(deleteEditionPrefix).mockClear();
    // Next day's build: the window slides by one, so exactly one more prefix (2026-10-04) goes.
    await buildEdition({ now: new Date(NOW.getTime() + 24 * 60 * MIN), source: makeSource(), floors });
    expect(vi.mocked(deleteEditionPrefix).mock.calls.map(([d]) => d)).toEqual(["2026-10-04"]);

    // Same day again: nothing new outside the window.
    vi.mocked(deleteEditionPrefix).mockClear();
    await buildEdition({ now: new Date(NOW.getTime() + 24 * 60 * MIN), source: makeSource(), floors });
    expect(deleteEditionPrefix).not.toHaveBeenCalled();
  });

  it("a prune failure is logged, never fatal, and leaves files so the next run retries", async () => {
    await seedTen();
    vi.mocked(deleteEditionPrefix).mockRejectedValue(new DatasetBlobError("blob_delete_failed"));
    const res = await buildEdition({ now: NOW, source: makeSource(), floors });
    expect(res.outcome).toBe("published");
    expect(errorSpy).toHaveBeenCalledWith("dataset edition: prune failed (code: blob_delete_failed)");
    const oldest = (await allEditions()).find((r) => r.editionDate === "2026-10-01")!;
    expect(oldest.files).toHaveLength(1);
  });
});
