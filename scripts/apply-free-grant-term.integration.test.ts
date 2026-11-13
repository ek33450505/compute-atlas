// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn(), unstable_cache: (fn: unknown) => fn }));

import { datasetAccessGrantsTable, emailSendsTable } from "@/lib/db/schema";
import { DATASET_COMMERCIAL_GRANT_TERM_MS, DATASET_FREE_GRANT_TERM_MS } from "@/lib/dataset-grants";
import { buildDatasetTermChangedEmail } from "@/lib/dataset-email-templates";
import type { EmailSendsDb } from "@/lib/email-sends";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { makePacer } from "@/lib/send-pacer";

import {
  MIN_REMAINING_MS,
  RefusalError,
  applyShorten,
  assertEnoughNotice,
  maskEmail,
  parseArgs,
  run,
  selectCandidates,
} from "./apply-free-grant-term";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60 * 1000;
let tdb: TestDbHandle;
const db = () => tdb.db as unknown as EmailSendsDb;

beforeAll(async () => {
  tdb = await makeTestDb();
  process.env.CONTRIBUTE_IP_SALT = "test-salt";
});
beforeEach(async () => {
  await tdb.reset();
});
afterAll(async () => {
  await tdb.client.close();
});

let seq = 0;
async function grant(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  seq++;
  const approvedAt = over.approvedAt ?? new Date(Date.now() - 10 * DAY);
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: `reader${seq}@example.com`,
      name: "Reader",
      category: "journalist",
      intendedUse: "testing",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status: "active",
      verifyTokenHash: `v${seq}`,
      approvedAt,
      expiresAt: new Date(approvedAt.getTime() + 365 * DAY),
      ...over,
    })
    .returning();
  return row;
}
const expiry = async (id: string) =>
  (await tdb.db.select().from(datasetAccessGrantsTable)).find((r) => r.id === id)!.expiresAt!;
const quiet = () => {};

describe("grants:term selection and apply", () => {
  it("parseArgs: dry run by default, rejects unknown flags", () => {
    expect(parseArgs([])).toEqual({ apply: false, notify: false, notifyIds: [] });
    expect(parseArgs(["--apply", "--notify"])).toEqual({ apply: true, notify: true, notifyIds: [] });
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--notify"])).toThrow(/only works with --apply/);
    expect(() => parseArgs(["--notify-ids", "not-a-uuid"])).toThrow(/UUIDs/);
    expect(() => parseArgs(["--apply", "--notify-ids", UUID_A])).toThrow(/on its own/);
  });

  it("selects free + active + overlong only: never a commercial, expired or already-short row", async () => {
    const free = await grant();
    await grant({ tier: "commercial", paidThrough: new Date(Date.now() + 30 * DAY) });
    await grant({ status: "expired" });
    await grant({ expiresAt: new Date(Date.now() + 20 * DAY) }); // already <= approved + 90d
    const picked = await selectCandidates(db());
    expect(picked.map((c) => c.id)).toEqual([free.id]);
  });

  it("apply sets approved_at + 90 days, leaves commercial untouched, and a re-run changes nothing", async () => {
    const approvedAt = new Date(Date.now() - 10 * DAY);
    const free = await grant({ approvedAt });
    const commercial = await grant({ tier: "commercial", paidThrough: new Date(Date.now() + 30 * DAY), approvedAt });
    const commercialBefore = await expiry(commercial.id);

    expect((await applyShorten(db())).map((g) => g.id)).toEqual([free.id]);
    expect((await expiry(free.id)).getTime()).toBe(approvedAt.getTime() + DATASET_FREE_GRANT_TERM_MS);
    expect((await expiry(commercial.id)).getTime()).toBe(commercialBefore.getTime());
    expect(commercialBefore.getTime()).toBe(approvedAt.getTime() + DATASET_COMMERCIAL_GRANT_TERM_MS);

    expect(await applyShorten(db())).toEqual([]);
  });

  it("single-use migration: a renewed or extended grant is never selected, written or mailed", async () => {
    const approvedAt = new Date(Date.now() - 10 * DAY);
    const renewed = await grant({ approvedAt, expiresAt: new Date(Date.now() + 200 * DAY) }); // expiry != approved + 365d
    const extended = await grant({ approvedAt, expiresAt: new Date(Date.now() + 90 * DAY) });
    const original = await grant({ approvedAt });
    const send = vi.fn(async () => ({ sent: true as const, resendId: "r1" }));
    expect((await selectCandidates(db())).map((c) => c.id)).toEqual([original.id]);
    await run(["--apply", "--notify"], { db: db(), send, pacer: makePacer(0), log: quiet });
    expect(send).toHaveBeenCalledOnce();
    expect((await expiry(renewed.id)).getTime()).toBe(renewed.expiresAt!.getTime());
    expect((await expiry(extended.id)).getTime()).toBe(extended.expiresAt!.getTime());
  });

  it("the UPDATE itself keeps the 7-day floor even if the dry-run refusal is bypassed", async () => {
    const tooSoon = await grant({ approvedAt: new Date(Date.now() - 88 * DAY) });
    const ok = await grant();
    expect((await applyShorten(db())).map((g) => g.id)).toEqual([ok.id]);
    expect((await expiry(tooSoon.id)).getTime()).toBe(tooSoon.expiresAt!.getTime());
  });

  it("refuses, before any write, when a new expiry is under now + 7 days", async () => {
    const ok = await grant();
    const tooSoon = await grant({ approvedAt: new Date(Date.now() - 88 * DAY) });
    const before = await expiry(tooSoon.id);
    await expect(run(["--apply"], { db: db(), log: quiet })).rejects.toThrow(RefusalError);
    await expect(run([], { db: db(), log: quiet })).rejects.toThrow(tooSoon.id.slice(0, 8));
    expect((await expiry(tooSoon.id)).getTime()).toBe(before.getTime());
    expect((await expiry(ok.id)).getTime()).toBe(ok.expiresAt!.getTime());
  });

  it("assertEnoughNotice accepts exactly the floor", () => {
    const now = new Date();
    const c = { id: "x".repeat(8), email: "a@b.co", approvedAt: now, expiresAt: now, renewalPending: false, newExpiresAt: new Date(now.getTime() + MIN_REMAINING_MS) };
    expect(() => assertEnoughNotice([c], now)).not.toThrow();
  });

  it("dry run writes nothing and prints no full address", async () => {
    const g = await grant();
    const lines: string[] = [];
    await run([], { db: db(), log: (l) => lines.push(l) });
    expect((await expiry(g.id)).getTime()).toBe(g.expiresAt!.getTime());
    expect(lines.join("\n")).not.toContain(g.email);
    expect(lines.join("\n")).toContain(maskEmail(g.email));
  });
});

describe("grants:term --notify", () => {
  const okSend = () => vi.fn(async () => ({ sent: true as const, resendId: "r1" }));
  const termRows = async () => (await tdb.db.select().from(emailSendsTable)).filter((r) => r.kind === "dataset_term_changed");

  it("apply + notify mails exactly the rows it shortened, and prints their full ids", async () => {
    const overlong = await grant();
    const already = await grant({ expiresAt: new Date(Date.now() + 20 * DAY) }); // already short: not in the RETURNING set
    const send = okSend();
    const lines: string[] = [];
    await run(["--apply", "--notify"], { db: db(), send, pacer: makePacer(0), log: (l) => lines.push(l) });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ email: overlong.email, expiresAt: new Date(overlong.approvedAt!.getTime() + DATASET_FREE_GRANT_TERM_MS) });
    expect((await termRows()).map((r) => r.targetId)).toEqual([overlong.id]);
    expect(lines.join("\n")).toContain(overlong.id);
    expect(lines.join("\n")).not.toContain(already.id);
    expect(lines.join("\n")).not.toContain(overlong.email);
  });

  it("a re-run of apply + notify mails nothing, and --notify-ids skips an already-sent grant", async () => {
    const g = await grant();
    const send = okSend();
    const args = { db: db(), send, pacer: makePacer(0), log: quiet };
    await run(["--apply", "--notify"], args);
    await run(["--apply", "--notify"], args);
    // Sent-only: no earlier FAILED attempt, so there is nothing to retry and the id is refused.
    await expect(run(["--notify-ids", g.id], args)).rejects.toThrow(/no earlier failed notice row/);
    expect(send).toHaveBeenCalledOnce();
    expect(await termRows()).toHaveLength(1);
  });

  it("--notify-ids retries a grant whose send failed", async () => {
    const g = await grant();
    const failing = vi.fn(async () => ({ sent: false as const, errorCode: "boom" }));
    // A failed send exits non-zero and names the ids to retry.
    await expect(run(["--apply", "--notify"], { db: db(), send: failing, pacer: makePacer(0), log: quiet })).rejects.toThrow(
      new RegExp(`--notify-ids ${g.id}`),
    );
    const send = okSend();
    await run(["--notify-ids", g.id], { db: db(), send, pacer: makePacer(0), log: quiet });
    expect(send).toHaveBeenCalledOnce();
    expect((await termRows()).map((r) => r.outcome).sort()).toEqual(["error", "sent"]);
  });

  it("--notify-ids refuses a grant on the 90-day term that no earlier run tried to notify", async () => {
    const approvedAt = new Date(Date.now() - 5 * DAY);
    const fresh = await grant({ approvedAt, expiresAt: new Date(approvedAt.getTime() + DATASET_FREE_GRANT_TERM_MS) });
    const send = okSend();
    await expect(run(["--notify-ids", fresh.id], { db: db(), send, pacer: makePacer(0), log: quiet })).rejects.toThrow(
      /no earlier failed notice row/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("--notify-ids refuses unknown, commercial and still-overlong ids before any send", async () => {
    const overlong = await grant();
    const commercial = await grant({ tier: "commercial", paidThrough: new Date(Date.now() + 30 * DAY), expiresAt: new Date(Date.now() + 80 * DAY), approvedAt: new Date(Date.now() - 10 * DAY) });
    const send = okSend();
    for (const id of [UUID_A, commercial.id, overlong.id]) {
      await expect(run(["--notify-ids", id], { db: db(), send, pacer: makePacer(0), log: quiet })).rejects.toThrow(RefusalError);
    }
    expect(send).not.toHaveBeenCalled();
    expect(await termRows()).toHaveLength(0);
  });
});

describe("grants:term without a Resend key", () => {
  it("--apply --notify refuses before any write", async () => {
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const g = await grant();
      await expect(run(["--apply", "--notify"], { db: db(), log: quiet })).rejects.toThrow(/RESEND_API_KEY/);
      expect((await expiry(g.id)).getTime()).toBe(g.expiresAt!.getTime());
      await expect(run(["--notify-ids", g.id], { db: db(), log: quiet })).rejects.toThrow(/RESEND_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.RESEND_API_KEY = saved;
    }
  });

  it("a skipped_no_key send during a run exits non-zero and prints the retry ids", async () => {
    const g = await grant();
    const noKey = vi.fn(async () => ({ sent: false as const, errorCode: "no_key", skipped: "no_key" as const }));
    await expect(run(["--apply", "--notify"], { db: db(), send: noKey, pacer: makePacer(0), log: quiet })).rejects.toThrow(
      new RegExp(`--notify-ids ${g.id}`),
    );
  });
});

describe("buildDatasetTermChangedEmail", () => {
  it("names the new date (escaped), says 90 and 365, and carries no link or token", () => {
    const mail = buildDatasetTermChangedEmail({ expiresAt: new Date("2027-02-11T12:00:00Z") });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("February 11, 2027");
      expect(body).toContain("90 days");
      expect(body).toContain("instead of 365");
      expect(body).not.toMatch(/https?:\/\//);
      expect(body).not.toContain("token");
    }
    expect(mail.subject).not.toMatch(/\d{4}/);
  });
});
