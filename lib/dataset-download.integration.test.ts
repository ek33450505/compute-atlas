// @vitest-environment node
import { createHash } from "node:crypto";

import { afterEach, beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// Only the Blob fetch is faked: the allowlist and the error class stay real.
vi.mock("@/lib/dataset-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataset-blob")>();
  return { ...actual, getEditionFileText: vi.fn() };
});

// Marking is the other writer's unit; here it is replaced by a visible wrapper so the key it received can be read.
vi.mock("@/lib/dataset-watermark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataset-watermark")>();
  return {
    ...actual,
    watermarkJsonArray: vi.fn((body: string) => `WM-JSON:${body}`),
    watermarkCsv: vi.fn((body: string) => `WM-CSV:${body}`),
  };
});

// Wrapped (not replaced) so a test can prove the token lookup was not reached.
vi.mock("@/lib/dataset-grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataset-grants")>();
  return { ...actual, getGrantByAccessToken: vi.fn(actual.getGrantByAccessToken) };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import {
  datasetAccessGrantsTable,
  datasetDownloadsTable,
  datasetEditionsTable,
  type DatasetEditionFile,
  type DatasetGrantStatus,
} from "@/lib/db/schema";
import { API_RATE_LIMIT_MAX, __resetApiRateLimit } from "@/lib/api-rate-limit";
import { DATASET_EDITION_FILES, DatasetBlobError, getEditionFileText } from "@/lib/dataset-blob";
import {
  DATASET_GRANT_DAILY_LIMIT,
  DATASET_STREAM_CHUNK_BYTES,
  handleDatasetFileRequest,
  handleDatasetHeadRequest,
} from "@/lib/dataset-download";
import { getGrantByAccessToken } from "@/lib/dataset-grants";
import { WatermarkError, watermarkCsv, watermarkJsonArray } from "@/lib/dataset-watermark";
import { generateToken } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";

let tdb: TestDbHandle;

const DAY = 24 * 60 * 60 * 1000;
const EDITION_DATE = "2026-11-08";
const SECRET = "test-watermark-secret-of-32-chars-or-more"; // the route requires >= 32 characters
const IP = "203.0.113.50";

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const bodyOf = (name: string) => `body of ${name}`;

const record = (name: string, text = bodyOf(name)): DatasetEditionFile => ({
  name,
  pathname: `editions/${EDITION_DATE}/${name}`,
  bytes: Buffer.byteLength(text, "utf8"),
  sha256: sha(text),
});

async function seedEdition(over: Partial<typeof datasetEditionsTable.$inferInsert> = {}): Promise<string> {
  const [row] = await tdb.db
    .insert(datasetEditionsTable)
    .values({
      editionDate: EDITION_DATE,
      builtAt: new Date(),
      status: "published",
      files: DATASET_EDITION_FILES.map((name) => record(name)),
      ...over,
    })
    .returning({ id: datasetEditionsTable.id });
  return row.id;
}

let seedCounter = 0;
async function seedGrant(
  over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}
): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const status: DatasetGrantStatus = over.status ?? "active";
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `grantee-${seedCounter++}@example.com`,
      name: "Grantee",
      category: "journalist",
      intendedUse: "seed",
      attributionAckAt: new Date(),
      termsVersion: "seed-terms",
      verifyTokenHash: hashToken(`verify-${seedCounter}`),
      accessTokenHash: hashToken(token),
      status,
      expiresAt: new Date(Date.now() + 30 * DAY),
      ...over,
    })
    .returning({ id: datasetAccessGrantsTable.id });
  return { id: row.id, token };
}

const downloads = () => tdb.db.select().from(datasetDownloadsTable);
const grantRow = async (id: string) =>
  (await tdb.db.select().from(datasetAccessGrantsTable).where(eq(datasetAccessGrantsTable.id, id)))[0];

function req(query: string, ip = IP, method = "GET"): Request {
  return new Request(`http://localhost/api/dataset/file?${query}`, { method, headers: { "x-forwarded-for": ip } });
}
const q = (token: string, f: string) => `t=${encodeURIComponent(token)}&f=${encodeURIComponent(f)}`;

/** Everything observable about a response, so "byte-identical" is one toEqual. */
async function fingerprint(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    body: await res.text(),
  };
}

const blobMock = vi.mocked(getEditionFileText);

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  vi.stubEnv("DATASET_WATERMARK_SECRET", SECRET);
  blobMock.mockReset();
  blobMock.mockImplementation(async (pathname: string) => bodyOf(pathname.split("/").pop() ?? ""));
  vi.mocked(watermarkJsonArray).mockClear();
  vi.mocked(watermarkCsv).mockClear();
  vi.mocked(getGrantByAccessToken).mockClear();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleSpies.forEach((s) => s.mockRestore());
});

afterAll(async () => {
  await tdb.client.close();
});

const expectBaseHeaders = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
};

/** Reads a body to the end, keeping each chunk's size. */
async function readChunks(res: Response): Promise<Uint8Array[]> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const loggedText = () => JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));

describe("the generic 404", () => {
  it("is byte-identical for every invalid cause, writes no row, and never reaches Blob with a bad path", async () => {
    await seedEdition();
    const live = await seedGrant();
    const revoked = await seedGrant({ status: "revoked", revokedAt: new Date() });
    const expired = await seedGrant({ status: "expired" });
    // Seeded WITH a matching token hash, so the status gate (not a failed hash lookup) is what rejects them.
    const pendingToken = generateToken();
    await seedGrant({ status: "pending_review", accessTokenHash: hashToken(pendingToken) });
    const rejectedToken = generateToken();
    await seedGrant({ status: "rejected", accessTokenHash: hashToken(rejectedToken) });
    const lapsedActive = await seedGrant({ expiresAt: new Date(Date.now() - DAY) });
    const renewalPending = await seedGrant({
      expiresAt: new Date(Date.now() - DAY),
      renewalRequestedAt: new Date(Date.now() - 2 * DAY),
    });
    const withToken = (t: { token: string }) => q(t.token, "README.txt");

    const cases: Array<[string, () => Promise<Response>]> = [
      ["flag off", async () => {
        vi.stubEnv("DATASET_SHARING_ENABLED", "false");
        try {
          return await handleDatasetFileRequest(req(q(live.token, "README.txt")));
        } finally {
          vi.stubEnv("DATASET_SHARING_ENABLED", "true"); // the later cases must reach the gates under test
        }
      }],
      ["traversal f", () => handleDatasetFileRequest(req(q(live.token, "../x")))],
      ["encoded traversal f", () => handleDatasetFileRequest(req(`t=${live.token}&f=..%2F..%2Fetc%2Fpasswd`))],
      ["NUL-suffixed f", () => handleDatasetFileRequest(req(`t=${live.token}&f=facilities.json%00`))],
      ["case variant f", () => handleDatasetFileRequest(req(q(live.token, "Facilities.json")))],
      ["path-prefixed f", () => handleDatasetFileRequest(req(q(live.token, "editions/2026-11-08/README.txt")))],
      ["array f", () => handleDatasetFileRequest(req(`t=${live.token}&f=README.txt&f=facilities.json`))],
      ["missing f", () => handleDatasetFileRequest(req(`t=${live.token}`))],
      ["missing t", () => handleDatasetFileRequest(req("f=README.txt"))],
      ["array t", () => handleDatasetFileRequest(req(`t=${live.token}&t=${revoked.token}&f=README.txt`))],
      ["unknown token", () => handleDatasetFileRequest(req(q(generateToken(), "README.txt")))],
      ["malformed token", () => handleDatasetFileRequest(req(q("short", "README.txt")))],
      ["revoked", () => handleDatasetFileRequest(req(withToken(revoked)))],
      ["expired status", () => handleDatasetFileRequest(req(withToken(expired)))],
      ["active but past expiry", () => handleDatasetFileRequest(req(withToken(lapsedActive)))],
      ["pending_review", () => handleDatasetFileRequest(req(q(pendingToken, "README.txt")))],
      ["rejected", () => handleDatasetFileRequest(req(q(rejectedToken, "README.txt")))],
      ["renewal-pending past expiry", () => handleDatasetFileRequest(req(withToken(renewalPending)))],
      ["no published edition", async () => {
        await tdb.db.delete(datasetEditionsTable);
        return handleDatasetFileRequest(req(q(live.token, "README.txt")));
      }],
    ];

    const prints = [];
    for (const [label, run] of cases) {
      // Each case gets its own IP bucket: this test is about the answer, not the limiter.
      __resetApiRateLimit();
      prints.push([label, await fingerprint(await run())] as const);
    }
    const [, first] = prints[0];
    expect(first.status).toBe(404);
    for (const [label, print] of prints) expect([label, print]).toEqual([label, first]);

    expect(await downloads()).toEqual([]);
    expect(blobMock).not.toHaveBeenCalled();

    // Control: the same live token with an allowlisted file is NOT a 404, so the cases above were not all
    // answered by one early gate (a flag left off, a shared IP bucket).
    await seedEdition(); // the last case above removed it
    __resetApiRateLimit();
    expect((await handleDatasetFileRequest(req(q(live.token, "README.txt")))).status).toBe(200);
  });

  it("carries no-store, noindex and no-referrer", async () => {
    const res = await handleDatasetFileRequest(req(q(generateToken(), "README.txt")));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does no token lookup and no Blob read for a non-allowlisted file", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    await handleDatasetFileRequest(req(q(token, "../x")));
    expect(getGrantByAccessToken).not.toHaveBeenCalled();
    expect(blobMock).not.toHaveBeenCalled();
  });
});

describe("a served download", () => {
  it.each(DATASET_EDITION_FILES)("serves %s with the right headers, a row and a counter bump", async (name) => {
    const editionId = await seedEdition();
    const { id, token } = await seedGrant();

    const res = await handleDatasetFileRequest(req(q(token, name)));

    expect(res.status).toBe(200);
    const marked =
      name === "facilities.json" ? `WM-JSON:${bodyOf(name)}` : name === "facilities.csv" ? `WM-CSV:${bodyOf(name)}` : bodyOf(name);
    expect(await res.text()).toBe(marked);
    const contentType = { json: "application/json; charset=utf-8", csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8" }[
      name.split(".").pop() as "json" | "csv" | "txt"
    ];
    expect(res.headers.get("content-type")).toBe(contentType);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="compute-atlas-${EDITION_DATE}-${name}"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const rows = await downloads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantId: id, editionId, file: name, outcome: "served" });
    expect(rows[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].ipHash).not.toContain(IP);

    const grant = await grantRow(id);
    expect(grant.downloadCount).toBe(1);
    expect(grant.lastDownloadAt).toBeInstanceOf(Date);
  });

  it("watermarks only the two record files, with this grant's and edition's key", async () => {
    const editionId = await seedEdition();
    const { id, token } = await seedGrant();

    for (const name of DATASET_EDITION_FILES) {
      await handleDatasetFileRequest(req(q(token, name)));
    }

    const key = { secret: SECRET, grantId: id, editionId };
    expect(watermarkJsonArray).toHaveBeenCalledTimes(1);
    expect(watermarkJsonArray).toHaveBeenCalledWith(bodyOf("facilities.json"), key);
    expect(watermarkCsv).toHaveBeenCalledTimes(1);
    expect(watermarkCsv).toHaveBeenCalledWith(bodyOf("facilities.csv"), key);
  });

  it("increments the counter on each download", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    await handleDatasetFileRequest(req(q(token, "README.txt")));
    await handleDatasetFileRequest(req(q(token, "changelog.json")));
    expect((await grantRow(id)).downloadCount).toBe(2);
  });

  it("serves the latest published edition, not a newer unpublished one", async () => {
    await seedEdition();
    await seedEdition({ editionDate: "2026-11-15", status: "building", files: [] });
    const { token } = await seedGrant();
    const res = await handleDatasetFileRequest(req(q(token, "README.txt")));
    expect(res.status).toBe(200);
    expect(blobMock).toHaveBeenCalledWith(`editions/${EDITION_DATE}/README.txt`);
  });

  it("still serves when the served-row write fails (fail-open bookkeeping), logging the SQLSTATE only", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    const insert = vi.spyOn(tdb.db, "insert").mockImplementation(() => {
      throw Object.assign(new Error("Failed query: insert ... params: SECRET-PARAM"), { code: "08006" });
    });
    try {
      const res = await handleDatasetFileRequest(req(q(token, "README.txt")));
      expect(res.status).toBe(200);
    } finally {
      insert.mockRestore();
    }
    expect(await downloads()).toEqual([]);
    // The body was served, so the counter moves even though no row could be reserved (no silent undercount).
    const grant = await grantRow(id);
    expect(grant.downloadCount).toBe(1);
    expect(grant.lastDownloadAt).toBeInstanceOf(Date);
    expect(loggedText()).toContain("08006");
    expect(loggedText()).not.toContain("SECRET-PARAM");
  });
});

describe("rate limits", () => {
  it("answers the per-IP limit BEFORE any token lookup and writes no row", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      await handleDatasetFileRequest(req("f=nope"));
    }
    vi.mocked(getGrantByAccessToken).mockClear();

    const res = await handleDatasetFileRequest(req(q(token, "README.txt")));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expectBaseHeaders(res);
    expect(getGrantByAccessToken).not.toHaveBeenCalled();
    expect(blobMock).not.toHaveBeenCalled();
    expect(await downloads()).toEqual([]);
  });

  it("does not let one IP's burst limit another IP", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    for (let i = 0; i <= API_RATE_LIMIT_MAX; i++) await handleDatasetFileRequest(req("f=nope"));
    const res = await handleDatasetFileRequest(req(q(token, "README.txt"), "203.0.113.99"));
    expect(res.status).toBe(200);
  });

  it("denies the 31st download in 24 h with a 429 and a denied_rate row", async () => {
    const editionId = await seedEdition();
    const { id, token } = await seedGrant();
    await tdb.db.insert(datasetDownloadsTable).values(
      Array.from({ length: DATASET_GRANT_DAILY_LIMIT }, () => ({
        grantId: id,
        editionId,
        file: "README.txt",
        outcome: "served" as const,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }))
    );
    blobMock.mockClear();

    const res = await handleDatasetFileRequest(req(q(token, "README.txt")));

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expectBaseHeaders(res);
    expect(blobMock).not.toHaveBeenCalled();
    const rows = await downloads();
    expect(rows.filter((r) => r.outcome === "denied_rate")).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === "served")).toHaveLength(DATASET_GRANT_DAILY_LIMIT);
    expect((await grantRow(id)).downloadCount).toBe(0);
  });

  it("serves the 30th, and ignores served rows older than 24 h, denied_rate and error rows", async () => {
    const editionId = await seedEdition();
    const { id, token } = await seedGrant();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const base = { grantId: id, editionId, file: "README.txt" };
    await tdb.db.insert(datasetDownloadsTable).values([
      ...Array.from({ length: DATASET_GRANT_DAILY_LIMIT - 1 }, () => ({ ...base, outcome: "served" as const })),
      ...Array.from({ length: 10 }, () => ({ ...base, outcome: "served" as const, createdAt: old })),
      ...Array.from({ length: 10 }, () => ({ ...base, outcome: "denied_rate" as const })),
      ...Array.from({ length: 10 }, () => ({ ...base, outcome: "error" as const })),
    ]);

    const res = await handleDatasetFileRequest(req(q(token, "README.txt")));
    expect(res.status).toBe(200);
  });

  it("counts per grant: another grantee's downloads do not count against this one", async () => {
    const editionId = await seedEdition();
    const other = await seedGrant();
    const { token } = await seedGrant();
    await tdb.db.insert(datasetDownloadsTable).values(
      Array.from({ length: DATASET_GRANT_DAILY_LIMIT }, () => ({
        grantId: other.id,
        editionId,
        file: "README.txt",
        outcome: "served" as const,
      }))
    );
    expect((await handleDatasetFileRequest(req(q(token, "README.txt")))).status).toBe(200);
  });
});

describe("failures after the grant is known (503 + an error row)", () => {
  const expectGeneric503 = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Temporarily unavailable. Please try again later." });
  };

  it.each(["facilities.json", "facilities.csv"])("never serves %s without a watermark secret", async (name) => {
    await seedEdition();
    const { token } = await seedGrant();
    for (const value of [undefined, ""]) {
      if (value === undefined) vi.stubEnv("DATASET_WATERMARK_SECRET", undefined as unknown as string);
      else vi.stubEnv("DATASET_WATERMARK_SECRET", value);
      __resetApiRateLimit();
      const res = await handleDatasetFileRequest(req(q(token, name)));
      await expectGeneric503(res);
    }
    expect(watermarkJsonArray).not.toHaveBeenCalled();
    expect(watermarkCsv).not.toHaveBeenCalled();
    // The check runs BEFORE the reserve: a misconfigured deploy writes no row per request.
    expect(await downloads()).toEqual([]);
    expect(blobMock).not.toHaveBeenCalled();
  });

  it.each(["facilities.json", "facilities.csv"])("treats a whitespace-only or 31-character secret as unset for %s", async (name) => {
    await seedEdition();
    const { token } = await seedGrant();
    for (const value of ["   \n\t ", "x".repeat(31), `  ${"x".repeat(30)}  `]) {
      vi.stubEnv("DATASET_WATERMARK_SECRET", value);
      __resetApiRateLimit();
      await expectGeneric503(await handleDatasetFileRequest(req(q(token, name))));
    }
    expect(watermarkJsonArray).not.toHaveBeenCalled();
    expect(watermarkCsv).not.toHaveBeenCalled();
    expect(await downloads()).toEqual([]);

    // Control: exactly 32 characters (after trimming) is accepted.
    vi.stubEnv("DATASET_WATERMARK_SECRET", `  ${"x".repeat(32)}  `);
    __resetApiRateLimit();
    expect((await handleDatasetFileRequest(req(q(token, name)))).status).toBe(200);
  });

  it("serves the other three files without the secret", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    vi.stubEnv("DATASET_WATERMARK_SECRET", "");
    for (const name of ["siting-context.json", "changelog.json", "README.txt"]) {
      expect((await handleDatasetFileRequest(req(q(token, name)))).status).toBe(200);
    }
  });

  it("refuses a file whose bytes differ from the published sha256, and never returns the body", async () => {
    const editionId = await seedEdition();
    const { id, token } = await seedGrant();
    blobMock.mockResolvedValue("TAMPERED-BODY same? no");

    const res = await handleDatasetFileRequest(req(q(token, "README.txt")));

    await expectGeneric503(res);
    expect(consoleSpies[3]).toHaveBeenCalledWith("dataset download: integrity mismatch (file: README.txt)");
    const rows = await downloads();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantId: id, editionId, file: "README.txt", outcome: "error" });
    expect((await grantRow(id)).downloadCount).toBe(0);
  });

  it("refuses a same-length file with a different hash", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    blobMock.mockResolvedValue(bodyOf("README.txt").replace("body", "BODY"));
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));
  });

  it("refuses a file whose hash matches but whose recorded size does not", async () => {
    await seedEdition({
      files: DATASET_EDITION_FILES.map((name) => ({ ...record(name), bytes: 1 })),
    });
    const { token } = await seedGrant();
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));
  });

  it("answers 503 and writes an error row when the blob is absent", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    blobMock.mockResolvedValue(null);
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));
    expect((await downloads()).map((r) => [r.grantId, r.outcome])).toEqual([[id, "error"]]);
  });

  it("answers 503 and writes an error row when the Blob read throws", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    blobMock.mockRejectedValue(new DatasetBlobError("blob_get_failed"));
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));
    expect((await downloads()).map((r) => r.outcome)).toEqual(["error"]);
    expect(loggedText()).toContain("blob_get_failed");
  });

  it("answers 503 and writes an error row when the edition has no record for the file", async () => {
    await seedEdition({ files: [record("facilities.json")] });
    const { token } = await seedGrant();
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));
    expect((await downloads()).map((r) => r.outcome)).toEqual(["error"]);
    expect(blobMock).not.toHaveBeenCalled();
  });

  it("settles the reserved row to error (not served) when something throws outside the settle paths", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    // Buffer.from(123) throws a TypeError after the reserve, outside every inner try/catch.
    blobMock.mockResolvedValue(123 as never);

    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "README.txt"))));

    const rows = await downloads();
    expect(rows.map((r) => [r.grantId, r.outcome])).toEqual([[id, "error"]]); // no unit of cap lost
    expect((await grantRow(id)).downloadCount).toBe(0);
    expect(loggedText()).not.toContain(token);
  });

  it("answers 503 and writes an error row when marking fails", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    vi.mocked(watermarkJsonArray).mockImplementationOnce(() => {
      throw new WatermarkError("watermark_parse_failed");
    });
    await expectGeneric503(await handleDatasetFileRequest(req(q(token, "facilities.json"))));
    expect((await downloads()).map((r) => r.outcome)).toEqual(["error"]);
    expect(loggedText()).toContain("watermark_parse_failed");
  });
});

describe("streaming", () => {
  it("returns a 6 MB body as a stream of <= 64 KiB chunks that reassemble to the source, with no Content-Length", async () => {
    // Vercel caps a NON-streamed response body at 4.5 MB; facilities.json is ~6.6-8.8 MB.
    const big = "x".repeat(6 * 1024 * 1024 - 1) + "\u00e9"; // ends in a 2-byte char: bytes != chars
    await seedEdition({ files: DATASET_EDITION_FILES.map((name) => (name === "siting-context.json" ? record(name, big) : record(name))) });
    const { token } = await seedGrant();
    blobMock.mockImplementation(async (pathname: string) => {
      const name = pathname.split("/").pop() ?? "";
      return name === "siting-context.json" ? big : bodyOf(name);
    });

    const res = await handleDatasetFileRequest(req(q(token, "siting-context.json")));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    const chunks = await readChunks(res);
    expect(chunks.length).toBeGreaterThan(90);
    expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(64 * 1024);
    expect(DATASET_STREAM_CHUNK_BYTES).toBe(64 * 1024);
    expect(Buffer.concat(chunks).equals(Buffer.from(big, "utf8"))).toBe(true);
  });
});

describe("the real watermark", () => {
  it("serves facilities.json equal to watermarkJsonArray(source, key), keeping the source byte length", async () => {
    const actual = await vi.importActual<typeof import("@/lib/dataset-watermark")>("@/lib/dataset-watermark");
    const source = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id: `site-${i}`, name: `Site ${i}` })), null, 2) + "\n";
    const editionId = await seedEdition({
      files: DATASET_EDITION_FILES.map((name) => (name === "facilities.json" ? record(name, source) : record(name))),
    });
    const { id, token } = await seedGrant();
    blobMock.mockResolvedValue(source);
    vi.mocked(watermarkJsonArray).mockImplementationOnce(actual.watermarkJsonArray);

    const res = await handleDatasetFileRequest(req(q(token, "facilities.json")));
    const served = await res.text();

    const expected = actual.watermarkJsonArray(source, { secret: SECRET, grantId: id, editionId });
    expect(served).toBe(expected);
    expect(served).not.toBe(source);
    expect(Buffer.byteLength(served)).toBe(Buffer.byteLength(source));
  });
});

describe("HEAD", () => {
  it("answers 405 with Allow: GET and the base headers, touching nothing", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();

    const res = handleDatasetHeadRequest(req(q(token, "facilities.json"), IP, "HEAD"));

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expectBaseHeaders(res);
    expect(await downloads()).toEqual([]);
    expect(blobMock).not.toHaveBeenCalled();
    expect(getGrantByAccessToken).not.toHaveBeenCalled();
    expect(watermarkJsonArray).not.toHaveBeenCalled();
    expect((await grantRow(id)).downloadCount).toBe(0);
  });

  it("is the same generic 404 as GET when the flag is off, so HEAD does not reveal the endpoint", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const head = await fingerprint(handleDatasetHeadRequest(req(q(generateToken(), "README.txt"), IP, "HEAD")));
    __resetApiRateLimit();
    const get = await fingerprint(await handleDatasetFileRequest(req(q(generateToken(), "README.txt"))));
    expect(head.status).toBe(404);
    expect(head).toEqual(get);
    expect(head.headers.map(([k]) => k)).not.toContain("allow");
  });

  it("is rate limited per IP: 429 with Retry-After and the base headers", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    let last!: Response;
    for (let i = 0; i <= API_RATE_LIMIT_MAX; i++) last = handleDatasetHeadRequest(req(q(token, "README.txt"), IP, "HEAD"));
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toMatch(/^\d+$/);
    expectBaseHeaders(last);
  });

  it("shares the GET bucket", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) handleDatasetHeadRequest(req("f=nope", IP, "HEAD"));
    expect((await handleDatasetFileRequest(req("f=nope"))).status).toBe(429);
  });
});

describe("the per-IP bucket is the IPv6 /64", () => {
  it("shares one bucket across addresses in the same /64, and not with another /64", async () => {
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) {
      await handleDatasetFileRequest(req("f=nope", `2001:db8:1:2:${i.toString(16)}::1`));
    }
    expect((await handleDatasetFileRequest(req("f=nope", "2001:db8:1:2:ffff:aaaa:bbbb:cccc"))).status).toBe(429);
    expect((await handleDatasetFileRequest(req("f=nope", "2001:db8:1:3::1"))).status).toBe(404);
  });
});

describe("the per-grant cap under a burst (reserve-then-count)", () => {
  const BURST = 35;
  const burst = (token: string) =>
    Promise.all(
      Array.from({ length: BURST }, (_, i) => handleDatasetFileRequest(req(q(token, "README.txt"), `198.51.100.${i + 1}`)))
    );

  /**
   * Holds every request at the token lookup until all BURST have arrived, then releases them together, so the
   * reserve (and the count) of all of them are in flight at once instead of one request finishing before the
   * next starts. Returns a restore function.
   */
  function holdAtLookup(): () => void {
    const original = vi.mocked(getGrantByAccessToken).getMockImplementation()!;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(getGrantByAccessToken).mockImplementation(async (token) => {
      const resolved = await original(token);
      if (++arrived === BURST) release();
      await gate;
      return resolved;
    });
    return () => vi.mocked(getGrantByAccessToken).mockImplementation(original);
  }

  it("never serves more than 30 when 35 requests are released together, and every other row is denied_rate", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    const restore = holdAtLookup();
    let responses: Response[];
    try {
      responses = await burst(token);
    } finally {
      restore();
    }

    const rows = await downloads();
    expect(rows).toHaveLength(BURST);
    const served = rows.filter((r) => r.outcome === "served");
    expect(served.length).toBeLessThanOrEqual(DATASET_GRANT_DAILY_LIMIT);
    expect(rows.filter((r) => r.outcome === "denied_rate")).toHaveLength(BURST - served.length);
    // Every request reserves before any counts, so every count sees all 35 reservations and every one is denied.
    // Over-denying under a perfect burst is acceptable: the grantee retries and the window is unchanged, whereas
    // over-serving would hand out files past the cap with no way to take them back. Count-then-insert would read
    // 0 in all 35 requests and serve all 35 (this assertion is the one that catches it).
    expect(served).toHaveLength(0);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(BURST);
    expect((await grantRow(id)).downloadCount).toBe(0);
  });

  it("serves exactly 30 and denies the other 5 when the same requests arrive one after another", async () => {
    await seedEdition();
    const { id, token } = await seedGrant();
    const statuses: number[] = [];
    for (let i = 0; i < BURST; i++) {
      statuses.push((await handleDatasetFileRequest(req(q(token, "README.txt"), `198.51.100.${i + 1}`))).status);
    }

    const rows = await downloads();
    expect(rows.filter((r) => r.outcome === "served")).toHaveLength(DATASET_GRANT_DAILY_LIMIT);
    expect(rows.filter((r) => r.outcome === "denied_rate")).toHaveLength(BURST - DATASET_GRANT_DAILY_LIMIT);
    expect(statuses.filter((s) => s === 200)).toHaveLength(DATASET_GRANT_DAILY_LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(BURST - DATASET_GRANT_DAILY_LIMIT);
    expect((await grantRow(id)).downloadCount).toBe(DATASET_GRANT_DAILY_LIMIT);
  });
});

describe("secrecy of the token", () => {
  it("never appears in console output, on any path", async () => {
    await seedEdition();
    const { token } = await seedGrant();

    await handleDatasetFileRequest(req(q(token, "README.txt"))); // served
    blobMock.mockResolvedValueOnce("tampered");
    await handleDatasetFileRequest(req(q(token, "changelog.json"))); // integrity
    blobMock.mockRejectedValueOnce(new DatasetBlobError("blob_get_failed"));
    await handleDatasetFileRequest(req(q(token, "siting-context.json"))); // blob
    await handleDatasetFileRequest(req(q(token, "../x"))); // 404

    expect(loggedText()).not.toContain(token);
  });
});

describe("no-store on every status", () => {
  it("holds for 200, 404, 429 and 503", async () => {
    await seedEdition();
    const { token } = await seedGrant();
    const ok = await handleDatasetFileRequest(req(q(token, "README.txt")));
    const nf = await handleDatasetFileRequest(req(q(token, "nope")));
    blobMock.mockResolvedValueOnce(null);
    const un = await handleDatasetFileRequest(req(q(token, "changelog.json")));
    for (let i = 0; i < API_RATE_LIMIT_MAX; i++) await handleDatasetFileRequest(req("f=nope"));
    const rl = await handleDatasetFileRequest(req(q(token, "README.txt")));

    expect([ok.status, nf.status, un.status, rl.status]).toEqual([200, 404, 503, 429]);
    for (const res of [ok, nf, un, rl]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    }
  });
});
