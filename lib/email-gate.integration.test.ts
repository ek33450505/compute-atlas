// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { emailSendsTable, subscriptionsTable } from "@/lib/db/schema";
import type { SendOutcome } from "@/lib/email";
import { sendGated } from "@/lib/email-gate";
import { CONFIRM_CAP_MAX, CONFIRM_CAP_WINDOW_MS, type EmailSendKind } from "@/lib/email-sends";
import { normalizeEmail } from "@/lib/email-address";
import { hashNotifyEmail } from "@/lib/rate-limit";
import { suppress } from "@/lib/suppressions";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
const EMAIL = "Gate.Reader@example.com";
const OK: SendOutcome = { sent: true, resendId: "r-1" };

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "email-gate-test-salt";
  tdb = await makeTestDb();
});
beforeEach(async () => {
  await tdb.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await tdb.client.close();
});

let seq = 0;
async function seedSub(status: "pending" | "confirmed" | "unsubscribed", over: { email?: string; targetId?: string } = {}) {
  seq++;
  const [row] = await tdb.db
    .insert(subscriptionsTable)
    .values({
      email: normalizeEmail(over.email ?? EMAIL),
      targetType: "state",
      targetId: over.targetId ?? "TN",
      status,
      confirmToken: `ct-${seq}`,
      unsubscribeToken: `ut-${seq}`,
    })
    .returning();
  return row;
}

const rows = () => tdb.db.select().from(emailSendsTable);
const sender = (outcome: SendOutcome = OK) => vi.fn(async () => outcome);
const gate = (kind: EmailSendKind, id: string, send: () => Promise<SendOutcome>, email = EMAIL) =>
  sendGated(tdb.db, { kind, subscriptionId: id, email }, send);

describe("sendGated: outcomes", () => {
  it("pending + confirm: sends and settles attempted -> sent", async () => {
    const sub = await seedSub("pending");
    const send = sender();
    expect(await gate("confirm", sub.id, send)).toEqual({ sent: true, disposition: "sent" });
    expect(send).toHaveBeenCalledOnce();
    const [row] = await rows();
    expect(row).toMatchObject({ kind: "confirm", outcome: "sent", resendId: "r-1", subscriptionId: sub.id });
    expect(row.completedAt).not.toBeNull();
  });

  it("a Resend failure settles the row as error with the code", async () => {
    const sub = await seedSub("pending");
    const res = await gate("confirm", sub.id, sender({ sent: false, errorCode: "rate_limit_exceeded" }));
    expect(res).toEqual({ sent: false, disposition: "send_failed" });
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "rate_limit_exceeded" });
  });

  it("a no-key result mirrors the row: skipped_no_key disposition, nothing counted", async () => {
    const sub = await seedSub("pending");
    const res = await gate("confirm", sub.id, sender({ sent: false, errorCode: "no_key", skipped: "no_key" }));
    expect(res).toEqual({ sent: false, disposition: "skipped_no_key" });
    expect((await rows())[0]).toMatchObject({ outcome: "skipped_no_key", errorCode: null });
  });

  it("a sender that throws is recorded as an error, not propagated", async () => {
    const sub = await seedSub("pending");
    const res = await gate("confirm", sub.id, async () => {
      throw new Error("boom");
    });
    expect(res.disposition).toBe("send_failed");
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "send_threw" });
  });

  it("a target suppression records skipped_suppressed and never calls the sender", async () => {
    const sub = await seedSub("pending");
    await suppress(tdb.db, EMAIL, { kind: "target", targetType: "state", targetId: "TN" }, "unsubscribe");
    const send = sender();
    expect(await gate("confirm", sub.id, send)).toEqual({ sent: false, disposition: "skipped_suppressed" });
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ outcome: "skipped_suppressed", subscriptionId: sub.id });
  });

  it("a global suppression blocks too", async () => {
    const sub = await seedSub("confirmed");
    await suppress(tdb.db, EMAIL, { kind: "global" }, "unsubscribe_all");
    const send = sender();
    expect((await gate("watch_started", sub.id, send)).disposition).toBe("skipped_suppressed");
    expect(send).not.toHaveBeenCalled();
  });

  it("an unreadable suppression list is not clear: no send, recorded as skipped_check_failed, not a suppression", async () => {
    const sub = await seedSub("pending");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tdb.client.exec("alter table email_suppressions rename to email_suppressions_away");
    const send = sender();
    try {
      expect(await gate("confirm", sub.id, send)).toEqual({ sent: false, disposition: "skipped_check_failed" });
    } finally {
      await tdb.client.exec("alter table email_suppressions_away rename to email_suppressions");
    }
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0].outcome).toBe("skipped_check_failed");
  });

  it("a confirmed row asked for a confirm mail: no send, skipped_unconfirmed", async () => {
    const sub = await seedSub("confirmed");
    const send = sender();
    expect((await gate("confirm", sub.id, send)).disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0].outcome).toBe("skipped_unconfirmed");
  });

  it("watch_started requires confirmed; a pending row is skipped_unconfirmed", async () => {
    const pending = await seedSub("pending");
    const send = sender();
    expect((await gate("watch_started", pending.id, send)).disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
    const confirmed = await seedSub("confirmed", { targetId: "CA" });
    expect((await gate("watch_started", confirmed.id, send)).disposition).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("re-reads the row by id: a row unsubscribed after the caller decided is not mailed", async () => {
    const sub = await seedSub("pending");
    await tdb.db.update(subscriptionsTable).set({ status: "unsubscribed" }).where(eq(subscriptionsTable.id, sub.id));
    const send = sender();
    expect((await gate("confirm", sub.id, send)).disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
  });

  it("a vanished row or an address mismatch sends nothing", async () => {
    const send = sender();
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect((await gate("confirm", ghost, send)).disposition).toBe("skipped_unconfirmed");
    expect((await rows())[0].subscriptionId).toBeNull();
    const sub = await seedSub("pending");
    expect((await gate("confirm", sub.id, send, "someone.else@example.com")).disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendGated: fail closed", () => {
  it("a recordSendAttempt failure means no send and no throw", async () => {
    const sub = await seedSub("pending");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await tdb.client.exec("alter table email_sends rename to email_sends_away");
    const send = sender();
    try {
      expect(await gate("confirm", sub.id, send)).toEqual({ sent: false, disposition: "gate_error" });
    } finally {
      await tdb.client.exec("alter table email_sends_away rename to email_sends");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed subscription lookup means no send and logs only a SQLSTATE", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await tdb.client.exec("alter table subscriptions rename to subscriptions_away");
    const send = sender();
    try {
      expect((await gate("confirm", "00000000-0000-4000-8000-000000000000", send)).disposition).toBe("gate_error");
    } finally {
      await tdb.client.exec("alter table subscriptions_away rename to subscriptions");
    }
    expect(send).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(" ")).not.toContain("00000000-0000");
  });
});

describe("sendGated: confirm cap", () => {
  const seedPriorConfirms = async (n: number, ageMs = 0) => {
    const at = new Date(Date.now() - ageMs);
    for (let i = 0; i < n; i++) {
      await tdb.db.insert(emailSendsTable).values({
        kind: "confirm",
        emailHash: hashNotifyEmail(normalizeEmail(EMAIL)),
        outcome: "sent",
        createdAt: at,
      });
    }
  };

  it(`allows the ${CONFIRM_CAP_MAX}th send and caps the next, settling its claim as skipped_capped`, async () => {
    await seedPriorConfirms(CONFIRM_CAP_MAX - 1);
    const sub = await seedSub("pending");
    const send = sender();
    expect((await gate("confirm", sub.id, send)).disposition).toBe("sent");
    const send11 = sender();
    expect(await gate("confirm", sub.id, send11)).toEqual({ sent: false, disposition: "skipped_capped" });
    expect(send11).not.toHaveBeenCalled();
    const all = await rows();
    expect(all.filter((r) => r.outcome === "skipped_capped")).toHaveLength(1);
    expect(all.filter((r) => r.outcome === "sent")).toHaveLength(CONFIRM_CAP_MAX);
  });

  it("a capped row does not spend budget: sends older than the window do not count", async () => {
    await seedPriorConfirms(CONFIRM_CAP_MAX + 5, CONFIRM_CAP_WINDOW_MS + 60_000);
    const sub = await seedSub("pending");
    expect((await gate("confirm", sub.id, sender())).disposition).toBe("sent");
  });

  it("sends just inside the window still count", async () => {
    await seedPriorConfirms(CONFIRM_CAP_MAX, CONFIRM_CAP_WINDOW_MS - 60_000);
    const sub = await seedSub("pending");
    expect((await gate("confirm", sub.id, sender())).disposition).toBe("skipped_capped");
  });

  it("concurrent confirms at the boundary interleave claims before counts and never send more than the cap", async () => {
    await seedPriorConfirms(CONFIRM_CAP_MAX - 3);
    const sub = await seedSub("pending");
    // Records claim inserts and cap counts in order, and yields after every
    // claim so concurrent gates genuinely interleave (a serial run would
    // also satisfy the bound, proving nothing).
    const events: ("claim" | "count")[] = [];
    const wrapped = new Proxy(tdb.db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...a: unknown[]) => {
            if (a[0] && typeof a[0] === "object" && "n" in (a[0] as object)) events.push("count");
            return (target.select as (...x: unknown[]) => unknown)(...a);
          };
        }
        if (prop === "insert") {
          return (table: unknown) => {
            const builder = target.insert(table as typeof emailSendsTable);
            return new Proxy(builder, {
              get(b, p) {
                if (p === "values") {
                  return (v: unknown) => {
                    const chain = b.values(v as never);
                    return new Proxy(chain, {
                      get(c, q) {
                        if (q === "returning") {
                          return async (...a: unknown[]) => {
                            const r = await (c.returning as (...x: unknown[]) => Promise<unknown>)(...a);
                            events.push("claim");
                            await new Promise((res) => setImmediate(res));
                            return r;
                          };
                        }
                        const val = Reflect.get(c, q);
                        return typeof val === "function" ? val.bind(c) : val;
                      },
                    });
                  };
                }
                const val = Reflect.get(b, p);
                return typeof val === "function" ? val.bind(b) : val;
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof tdb.db;

    const send = vi.fn(async () => OK);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => sendGated(wrapped, { kind: "confirm", subscriptionId: sub.id, email: EMAIL }, send))
    );

    const claimsBeforeFirstCount = events.indexOf("count");
    expect(claimsBeforeFirstCount).toBeGreaterThanOrEqual(2);
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.sent).length).toBe(send.mock.calls.length);
    expect((await rows()).filter((r) => r.outcome === "sent").length).toBeLessThanOrEqual(CONFIRM_CAP_MAX);
  });
});
