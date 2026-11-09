// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { datasetAccessGrantsTable, emailSuppressionsTable, type DatasetGrantStatus } from "@/lib/db/schema";
import { getGrantByAccessToken } from "@/lib/dataset-grants";
import { DATASET_NOTICE_SCOPE, unsubscribeDatasetNotices } from "@/lib/dataset-unsubscribe";
import { generateToken } from "@/lib/email";
import { sendGrantGated } from "@/lib/email-gate";
import { isSuppressed, suppressionStatuses } from "@/lib/suppressions";
import { hashToken } from "@/lib/token-hash";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "dataset-unsub-test-salt";
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

let seq = 0;
async function seedGrant(over: { status?: DatasetGrantStatus; email?: string } = {}) {
  seq++;
  const accessToken = generateToken();
  const unsubscribeToken = generateToken();
  const status = over.status ?? "active";
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: over.email ?? `reader${seq}@example.com`,
      name: "Reader",
      category: "journalist",
      intendedUse: "testing",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status,
      verifyTokenHash: `v${seq}`.padEnd(64, "0"),
      accessTokenHash: hashToken(accessToken),
      unsubscribeToken,
      expiresAt: status === "active" ? new Date(Date.now() + 30 * DAY) : null,
    })
    .returning();
  return { row, accessToken, unsubscribeToken };
}

const suppressionRows = () => tdb.db.select().from(emailSuppressionsTable);

describe("unsubscribeDatasetNotices", () => {
  it("writes one dataset_edition/weekly suppression stamped with the token hash", async () => {
    const { row, unsubscribeToken } = await seedGrant();
    expect(await unsubscribeDatasetNotices(unsubscribeToken)).toEqual({ outcome: "unsubscribed" });

    const rows = await suppressionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: row.email,
      targetType: "dataset_edition",
      targetId: "weekly",
      source: "unsubscribe",
      sourceTokenHash: hashToken(unsubscribeToken),
    });
    expect(await isSuppressed(tdb.db as never, row.email, DATASET_NOTICE_SCOPE)).toBe("suppressed");
  });

  it("is idempotent", async () => {
    const { unsubscribeToken } = await seedGrant();
    await unsubscribeDatasetNotices(unsubscribeToken);
    expect(await unsubscribeDatasetNotices(unsubscribeToken)).toEqual({ outcome: "unsubscribed" });
    expect(await suppressionRows()).toHaveLength(1);
  });

  it.each([["revoked"], ["expired"], ["rejected"], ["pending_review"]] as const)(
    "works for a %s grant",
    async (status) => {
      const { unsubscribeToken } = await seedGrant({ status });
      expect(await unsubscribeDatasetNotices(unsubscribeToken)).toEqual({ outcome: "unsubscribed" });
      expect(await suppressionRows()).toHaveLength(1);
    }
  );

  it.each([["short", "abc"], ["empty", ""], ["malformed", "!".repeat(43)]])(
    "a %s token is invalid and never reaches the DB",
    async (_label, token) => {
      vi.mocked(dbClient.getDb).mockClear();
      expect(await unsubscribeDatasetNotices(token)).toEqual({ outcome: "invalid" });
      expect(dbClient.getDb).not.toHaveBeenCalled();
      expect(await suppressionRows()).toHaveLength(0);
    }
  );

  it("an unknown well-formed token is invalid and writes nothing", async () => {
    await seedGrant();
    expect(await unsubscribeDatasetNotices(generateToken())).toEqual({ outcome: "invalid" });
    expect(await suppressionRows()).toHaveLength(0);
  });

  it("the access token is not an unsubscribe token", async () => {
    const { accessToken } = await seedGrant();
    expect(await unsubscribeDatasetNotices(accessToken)).toEqual({ outcome: "invalid" });
    expect(await suppressionRows()).toHaveLength(0);
  });

  it("does not revoke access: the grant row and the personal link are untouched", async () => {
    const { row, accessToken, unsubscribeToken } = await seedGrant();
    await unsubscribeDatasetNotices(unsubscribeToken);

    const [after] = await tdb.db.select().from(datasetAccessGrantsTable).where(eq(datasetAccessGrantsTable.id, row.id));
    expect(after).toEqual(row);
    const resolved = await getGrantByAccessToken(accessToken);
    expect(resolved.state).toBe("active");
  });

  it("only suppresses the notice scope: other targets for the same address stay clear", async () => {
    const { row, unsubscribeToken } = await seedGrant();
    await unsubscribeDatasetNotices(unsubscribeToken);
    const [other] = await suppressionStatuses(tdb.db as never, row.email, [
      { kind: "target", targetType: "dataset", targetId: row.id },
    ]);
    expect(other).toBe("clear");
  });
});

describe("the email gate honours the unsubscribe", () => {
  it("sendGrantGated(dataset_edition_notice) is skipped_suppressed after, and sends before", async () => {
    const { row, unsubscribeToken } = await seedGrant();
    const send = vi.fn(async () => ({ sent: true as const, resendId: "r-1" }));
    const gate = () =>
      sendGrantGated(tdb.db as never, { kind: "dataset_edition_notice", grantId: row.id, email: row.email, editionId: "ed-1" }, send);

    // Control: without the unsubscribe this same call sends, so the skip below is the suppression's doing.
    expect(await gate()).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);

    await unsubscribeDatasetNotices(unsubscribeToken);
    expect(await sendGrantGated(tdb.db as never, { kind: "dataset_edition_notice", grantId: row.id, email: row.email, editionId: "ed-2" }, send)).toEqual({
      sent: false,
      disposition: "skipped_suppressed",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
