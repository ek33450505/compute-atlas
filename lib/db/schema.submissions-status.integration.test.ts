// @vitest-environment node
/**
 * The DB-level half of the core invariant's staging rule: `submissions.status`
 * may only ever be one of `REVIEW_STATUSES`, enforced by the
 * `submissions_status_check` CHECK constraint (drizzle/0015, declared in
 * lib/db/schema.ts).
 *
 * Why this file exists rather than a unit test: the thing under test is a
 * Postgres constraint, so the only assertion that means anything is a real
 * INSERT against a real Postgres rejecting a real value. PGlite applies every
 * migration in drizzle/ (see test/pglite-db.ts), so the constraint here is the
 * same DDL production gets.
 *
 * It is ALSO the drift test that holds the duplication: the allowed set is
 * written as a literal in the migration and in lib/db/schema.ts, but cannot be
 * imported from `REVIEW_STATUSES` (lib/submissions.ts imports lib/db/schema.ts,
 * so importing back would be a cycle). The first test below drives every
 * `REVIEW_STATUSES` member through the real constraint, so adding a fourth
 * status to that array without extending the constraint turns this red instead
 * of failing in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { submissionsTable } from "@/lib/db/schema";
import { REVIEW_STATUSES, createSubmission } from "@/lib/submissions";

let tdb: TestDbHandle;

const PAYLOAD = { id: "x-tx", name: "X" };
const PROVENANCE = { sources: ["https://example.com/s"], discoveredBy: "test" };

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

describe("submissions_status_check", () => {
  it.each(REVIEW_STATUSES)("accepts the REVIEW_STATUSES member %s", async (status) => {
    // Drives the real constraint with every value the app considers legal. If
    // REVIEW_STATUSES grows and the constraint does not, this fails here rather
    // than as a 23514 in production.
    await tdb.db.insert(submissionsTable).values({
      status,
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(status);
  });

  it.each([
    ["a plausible but unlisted status", "promoted"],
    ["a case variant of a legal value", "Approved"],
    ["a near-miss typo", "reject"],
    ["the empty string", ""],
    ["a whitespace-padded legal value", " pending "],
  ])("rejects %s with SQLSTATE 23514", async (_label, status) => {
    // Postgres' check_violation. The status code matters, not just the throw:
    // a NOT NULL or type error would also throw, and would prove nothing about
    // this constraint.
    const attempt = tdb.db.insert(submissionsTable).values({
      status,
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23514" }),
    });
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
  });

  it("rejects the exact bypass the constraint exists for: a writer that explicitly passes 'approved' when it means 'pending'", async () => {
    // Before the constraint, `status` was plain `text` with a `'pending'`
    // DEFAULT — and a DEFAULT only applies when the column is OMITTED. Any
    // future writer that passed `status` at all (a new pipeline lane, a
    // hand-written backfill, an ad-hoc Neon INSERT) could land straight at a
    // reviewed state. 'approved' itself is legal, so the constraint cannot stop
    // that specific value; what it CAN stop is every value outside the domain,
    // which is what an accidental or adversarial writer most often produces.
    const attempt = tdb.db.insert(submissionsTable).values({
      status: "auto-approved",
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23514" }),
    });
  });

  it("still defaults to pending when status is omitted", async () => {
    await tdb.db.insert(submissionsTable).values({
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows[0].status).toBe("pending");
  });

  it("does not break the real intake path — createSubmission still stages pending", async () => {
    const result = await createSubmission({
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    expect(result.ok).toBe(true);
    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("rejects an UPDATE to an illegal status, not only an INSERT", async () => {
    // `NOT VALID` in the migration skips validating PRE-EXISTING rows; it does
    // NOT weaken enforcement on writes. An UPDATE must be caught too, or an
    // approve/reject path could still walk a row out of the domain.
    await tdb.db.insert(submissionsTable).values({
      kind: "create",
      payload: PAYLOAD,
      provenance: PROVENANCE,
    });
    const attempt = tdb.db.update(submissionsTable).set({ status: "archived" });
    await expect(attempt).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23514" }),
    });
    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows[0].status).toBe("pending");
  });
});
