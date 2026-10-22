// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emailSendsTable } from "@/lib/db/schema";
import { hashAddress, type EmailSendsDb } from "@/lib/email-sends";
import {
  EMAIL_SENDS_DEFAULT_LIMIT,
  EMAIL_SENDS_MAX_LIMIT,
  countEmailSendsByOutcome,
  listEmailSends,
  parseIsoDate,
} from "@/lib/email-sends-query";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
let db: EmailSendsDb;

const A = hashAddress("a@example.com");
const B = hashAddress("b@example.com");
const RUN = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "test-salt-for-email-sends-query";
  tdb = await makeTestDb();
  db = tdb.db;
});
beforeEach(async () => {
  await tdb.reset();
});
afterAll(async () => {
  await tdb.client.close();
});

type Seed = Partial<typeof emailSendsTable.$inferInsert>;
async function seed(rows: Seed[]) {
  await tdb.db.insert(emailSendsTable).values(rows.map((r) => ({ kind: "confirm", emailHash: A, ...r })));
}

describe("listEmailSends", () => {
  it("returns newest first and exposes only an 8-char hash prefix", async () => {
    await seed([
      { createdAt: new Date("2026-10-01T00:00:00Z"), targetId: "old" },
      { createdAt: new Date("2026-10-03T00:00:00Z"), targetId: "new" },
      { createdAt: new Date("2026-10-02T00:00:00Z"), targetId: "mid" },
    ]);
    const rows = await listEmailSends(db);
    expect(rows.map((r) => r.targetId)).toEqual(["new", "mid", "old"]);
    expect(rows[0].hashPrefix).toBe(A.slice(0, 8));
    expect(JSON.stringify(rows)).not.toContain(A);
    expect(Object.keys(rows[0])).not.toContain("emailHash");
  });

  it("filters by kind, outcome, run, hash and date range (inclusive days)", async () => {
    await seed([
      { kind: "confirm", outcome: "sent", createdAt: new Date("2026-10-01T10:00:00Z") },
      { kind: "state_digest", outcome: "error", createdAt: new Date("2026-10-02T23:59:00Z"), emailHash: B },
      { kind: "state_digest", outcome: "sent", createdAt: new Date("2026-10-04T00:00:00Z") },
    ]);
    expect(await listEmailSends(db, { kind: "state_digest" })).toHaveLength(2);
    expect(await listEmailSends(db, { outcome: "error" })).toHaveLength(1);
    expect(await listEmailSends(db, { emailHash: B })).toHaveLength(1);
    expect(await listEmailSends(db, { since: "2026-10-02" })).toHaveLength(2);
    expect(await listEmailSends(db, { until: "2026-10-02" })).toHaveLength(2);
    expect(await listEmailSends(db, { since: "2026-10-02", until: "2026-10-02" })).toHaveLength(1);
    expect(await listEmailSends(db, { runId: RUN })).toHaveLength(0);
  });

  it("caps limit at 500 and defaults to 200", async () => {
    await seed(Array.from({ length: 510 }, () => ({})));
    expect(await listEmailSends(db)).toHaveLength(EMAIL_SENDS_DEFAULT_LIMIT);
    expect(await listEmailSends(db, { limit: 9999 })).toHaveLength(EMAIL_SENDS_MAX_LIMIT);
    expect(await listEmailSends(db, { limit: 5 })).toHaveLength(5);
  });

  it("drops invalid filters instead of interpolating them", async () => {
    await seed([{}, { kind: "state_digest" }]);
    const bad = {
      kind: "confirm' OR '1'='1",
      outcome: "x'; DROP TABLE email_sends; --",
      since: "2026-13-45",
      until: "not-a-date",
      runId: "nope",
      emailHash: "zz",
    };
    expect(await listEmailSends(db, bad)).toHaveLength(2);
    expect(await listEmailSends(db)).toHaveLength(2);
  });
});

describe("countEmailSendsByOutcome", () => {
  it("counts per outcome under the same filters, ignoring limit", async () => {
    await seed([{ outcome: "sent" }, { outcome: "sent" }, { outcome: "error", kind: "state_digest" }]);
    expect(await countEmailSendsByOutcome(db, { limit: 1 })).toEqual({ sent: 2, error: 1 });
    expect(await countEmailSendsByOutcome(db, { kind: "state_digest" })).toEqual({ error: 1 });
  });
});

describe("parseIsoDate", () => {
  it("accepts real dates only", () => {
    expect(parseIsoDate("2026-10-21")?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2026-1-1")).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
  });
});
