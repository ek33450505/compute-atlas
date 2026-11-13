// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { datasetAccessGrantsTable, emailSendsTable, type DatasetGrantStatus } from "@/lib/db/schema";
import type { SendOutcome } from "@/lib/email";
import { normalizeEmail } from "@/lib/email-address";
import { sendDatasetAdminNoticeGated, sendGated, sendGrantGated, type DatasetRequesterKind } from "@/lib/email-gate";
import {
  DATASET_ADMIN_NOTICE_CAP_MAX,
  DATASET_REQUESTER_CAP_MAX,
  hashAddress,
  type EmailSendKind,
} from "@/lib/email-sends";
import { suppress } from "@/lib/suppressions";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
const EMAIL = "Data.Reader@example.com";
const OK: SendOutcome = { sent: true, resendId: "r-1" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "email-gate-dataset-test-salt";
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

const REQUESTER_KINDS: DatasetRequesterKind[] = [
  "dataset_verify",
  "dataset_already_active",
  "dataset_approved",
  "dataset_rejected",
  "dataset_edition_notice",
  "dataset_renewal_reminder",
  "dataset_link_reissued",
  "dataset_term_changed",
];
const STATUSES: DatasetGrantStatus[] = ["unverified", "pending_review", "active", "expired", "revoked", "rejected"];

type Lifecycle = "live" | "renewal_pending" | "lapsed";
type SeedOver = {
  email?: string;
  tier?: "free" | "commercial";
  status?: DatasetGrantStatus;
  lifecycle?: Lifecycle;
};

let seq = 0;
async function seedGrant(over: SeedOver = {}) {
  seq++;
  const status = over.lifecycle ? "active" : (over.status ?? "pending_review");
  const lifecycle = over.lifecycle;
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: normalizeEmail(over.email ?? `reader${seq}@example.com`),
      name: "Reader",
      category: "journalist",
      intendedUse: "testing",
      attributionAckAt: new Date(),
      termsVersion: "t",
      status,
      tier: over.tier ?? "free",
      paidThrough: over.tier === "commercial" ? new Date(Date.now() + 30 * DAY) : null,
      verifyTokenHash: `v${seq}`.padEnd(64, "0"),
      expiresAt: lifecycle === "live" ? new Date(Date.now() + 5 * DAY) : lifecycle ? new Date(Date.now() - DAY) : null,
      renewalRequestedAt: lifecycle === "renewal_pending" ? new Date(Date.now() - 2 * DAY) : null,
    })
    .returning();
  return row;
}

const rows = () => tdb.db.select().from(emailSendsTable);
const sender = (outcome: SendOutcome = OK) => vi.fn(async () => outcome);
const grantGate = (
  kind: DatasetRequesterKind,
  grantId: string,
  email: string,
  send: () => Promise<SendOutcome>,
  editionId?: string
) => sendGrantGated(tdb.db, { kind, grantId, email, editionId: kind === "dataset_edition_notice" ? (editionId ?? "ed-1") : editionId }, send);

/** Which grant states each requester kind may mail. */
function allowed(kind: DatasetRequesterKind, state: DatasetGrantStatus | Lifecycle): boolean {
  if (kind === "dataset_verify") return state === "unverified";
  if (kind === "dataset_rejected") return state === "rejected";
  if (kind === "dataset_already_active") return state === "live" || state === "renewal_pending";
  return state === "live";
}

async function backdate(minutesAgo: number, kind: string, email: string, outcome = "sent") {
  await tdb.db.insert(emailSendsTable).values({
    kind,
    emailHash: hashAddress(email),
    outcome,
    createdAt: new Date(Date.now() - minutesAgo * 60 * 1000),
  });
}

describe("sendGrantGated: dataset_term_changed is free-tier only", () => {
  it("skips a live commercial grant and sends to a live free one", async () => {
    const commercial = await seedGrant({ lifecycle: "live", tier: "commercial" });
    const send = sender();
    const res = await grantGate("dataset_term_changed", commercial.id, commercial.email, send);
    expect(res).toEqual({ sent: false, disposition: "skipped_unconfirmed" });
    expect(send).not.toHaveBeenCalled();

    const free = await seedGrant({ lifecycle: "live" });
    expect(await grantGate("dataset_term_changed", free.id, free.email, send)).toEqual({ sent: true, disposition: "sent" });
  });
});

describe("sendGrantGated: state gates", () => {
  for (const kind of REQUESTER_KINDS) {
    for (const status of STATUSES.filter((s) => s !== "active")) {
      it(`${kind} x ${status}: ${allowed(kind, status) ? "sends" : "skipped_unconfirmed"}`, async () => {
        const g = await seedGrant({ status });
        const send = sender();
        const res = await grantGate(kind, g.id, g.email, send);
        const [row] = await rows();
        if (allowed(kind, status)) {
          expect(res).toEqual({ sent: true, disposition: "sent" });
          expect(send).toHaveBeenCalledOnce();
          expect(row.outcome).toBe("sent");
        } else {
          expect(res).toEqual({ sent: false, disposition: "skipped_unconfirmed" });
          expect(send).not.toHaveBeenCalled();
          expect(row.outcome).toBe("skipped_unconfirmed");
        }
        expect((await rows()).length).toBe(1);
        expect(row).toMatchObject({ kind, subscriptionId: null });
        if (kind === "dataset_edition_notice") {
          expect(row).toMatchObject({ targetType: "dataset_edition", targetId: `ed-1:${g.id}` });
        } else {
          expect(row).toMatchObject({ targetType: "dataset", targetId: g.id });
        }
      });
    }
  }

  for (const kind of REQUESTER_KINDS) {
    for (const lifecycle of ["live", "renewal_pending", "lapsed"] as const) {
      it(`${kind} x active/${lifecycle}: ${allowed(kind, lifecycle) ? "sends" : "skipped_unconfirmed"}`, async () => {
        const g = await seedGrant({ lifecycle });
        const send = sender();
        const res = await grantGate(kind, g.id, g.email, send);
        if (allowed(kind, lifecycle)) {
          expect(res.disposition).toBe("sent");
          expect(send).toHaveBeenCalledOnce();
        } else {
          expect(res).toEqual({ sent: false, disposition: "skipped_unconfirmed" });
          expect(send).not.toHaveBeenCalled();
        }
      });
    }
  }

  it("a vanished grant id is skipped_unconfirmed and recorded", async () => {
    const send = sender();
    const res = await grantGate("dataset_verify", "00000000-0000-4000-8000-000000000000", EMAIL, send);
    expect(res.disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ outcome: "skipped_unconfirmed", subscriptionId: null });
  });

  it("an address mismatch is skipped_unconfirmed", async () => {
    const g = await seedGrant({ status: "unverified" });
    const send = sender();
    const res = await grantGate("dataset_verify", g.id, "someone.else@example.com", send);
    expect(res.disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
  });

  it("case and padding variants of the grant's address still match", async () => {
    const g = await seedGrant({ status: "unverified", email: "a.b@example.com" });
    expect((await grantGate("dataset_verify", g.id, "  A.B@Example.com ", sender())).disposition).toBe("sent");
  });

  it("an edition notice without an editionId sends nothing", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    const send = sender();
    const res = await sendGrantGated(tdb.db, { kind: "dataset_edition_notice", grantId: g.id, email: g.email }, send);
    expect(res.disposition).toBe("skipped_unconfirmed");
    expect(send).not.toHaveBeenCalled();
    expect((await rows()).length).toBe(1);
  });

  it("an admin or unknown kind sends nothing and writes no row", async () => {
    const g = await seedGrant({ status: "unverified" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const kind of ["dataset_admin_new_request", "confirm", "nope"]) {
      const send = sender();
      const res = await sendGrantGated(tdb.db, { kind: kind as never, grantId: g.id, email: g.email }, send);
      expect(res.sent).toBe(false);
      expect(send).not.toHaveBeenCalled();
    }
    expect(await rows()).toHaveLength(0);
  });

  it("a grant lookup DB error is gate_error with no send and no row", async () => {
    const g = await seedGrant({ status: "unverified" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(tdb.db, "select").mockImplementation((() => {
      throw new Error("boom");
    }) as never);
    const send = sender();
    const res = await grantGate("dataset_verify", g.id, g.email, send);
    vi.restoreAllMocks();
    expect(res.disposition).toBe("gate_error");
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("a Resend failure settles the row as error", async () => {
    const g = await seedGrant({ status: "unverified" });
    const res = await grantGate("dataset_verify", g.id, g.email, sender({ sent: false, errorCode: "rate_limit_exceeded" }));
    expect(res).toEqual({ sent: false, disposition: "send_failed" });
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "rate_limit_exceeded" });
  });
});

describe("sendGrantGated: suppression", () => {
  const stateFor = (kind: DatasetRequesterKind): SeedOver => {
    if (kind === "dataset_verify") return { status: "unverified" };
    if (kind === "dataset_rejected") return { status: "rejected" };
    return { lifecycle: "live" };
  };

  for (const kind of REQUESTER_KINDS) {
    it(`a global suppression gives skipped_suppressed for ${kind}`, async () => {
      const g = await seedGrant(stateFor(kind));
      await suppress(tdb.db, g.email, { kind: "global" }, "unsubscribe");
      const send = sender();
      const res = await grantGate(kind, g.id, g.email, send);
      expect(res.disposition).toBe("skipped_suppressed");
      expect(send).not.toHaveBeenCalled();
    });
  }

  it("the weekly edition-notice target suppression blocks the notice only", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    await suppress(tdb.db, g.email, { kind: "target", targetType: "dataset_edition", targetId: "weekly" }, "unsubscribe");
    const notice = sender();
    expect((await grantGate("dataset_edition_notice", g.id, g.email, notice)).disposition).toBe("skipped_suppressed");
    expect(notice).not.toHaveBeenCalled();
    const approved = sender();
    expect((await grantGate("dataset_approved", g.id, g.email, approved)).disposition).toBe("sent");
    expect(approved).toHaveBeenCalledOnce();
  });

  it("a suppression lookup failure is skipped_check_failed, not a suppression", async () => {
    const g = await seedGrant({ status: "unverified" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const orig = tdb.db.select.bind(tdb.db);
    vi.spyOn(tdb.db, "select").mockImplementation(((...args: unknown[]) => {
      const fields = args[0] as Record<string, unknown> | undefined;
      if (fields && "targetType" in fields && "targetId" in fields && !("email" in fields)) throw new Error("boom");
      return (orig as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const send = sender();
    const res = await grantGate("dataset_verify", g.id, g.email, send);
    vi.restoreAllMocks();
    expect(res.disposition).toBe("skipped_check_failed");
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0].outcome).toBe("skipped_check_failed");
  });
});

describe("sendGrantGated: requester cap", () => {
  it("allows 5 per hour across a MIX of verify + already_active, then caps the 6th", async () => {
    const g = await seedGrant({ status: "unverified" });
    for (let i = 0; i < 2; i++) expect((await grantGate("dataset_verify", g.id, g.email, sender())).disposition).toBe("sent");
    // The same address moves on to a live grant; the budget is per address, shared by both kinds.
    await tdb.db
      .update(datasetAccessGrantsTable)
      .set({ status: "active", expiresAt: new Date(Date.now() + 5 * DAY) })
      .where(eq(datasetAccessGrantsTable.id, g.id));
    for (let i = 0; i < 3; i++) expect((await grantGate("dataset_already_active", g.id, g.email, sender())).disposition).toBe("sent");
    const send = sender();
    const res = await grantGate("dataset_already_active", g.id, g.email, send);
    expect(res.disposition).toBe("skipped_capped");
    expect(send).not.toHaveBeenCalled();
    const capped = (await rows()).filter((r) => r.outcome === "skipped_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0].kind).toBe("dataset_already_active");
    // Another address is unaffected.
    const other = await seedGrant({ status: "unverified" });
    expect((await grantGate("dataset_verify", other.id, other.email, sender())).disposition).toBe("sent");
  });

  it("skipped rows do not spend the budget; rows older than an hour do not count", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    for (let i = 0; i < 10; i++) await backdate(5, "dataset_verify", g.email, "skipped_suppressed");
    for (let i = 0; i < 10; i++) await backdate(5, "dataset_verify", g.email, "skipped_unconfirmed");
    // 5 (not 10): these still count toward the 24 h cap, so 5 + the 5 sends below stays within it.
    for (let i = 0; i < 5; i++) await backdate(61, "dataset_verify", g.email);
    for (let i = 0; i < DATASET_REQUESTER_CAP_MAX; i++) {
      expect((await grantGate("dataset_already_active", g.id, g.email, sender())).disposition).toBe("sent");
    }
    expect((await grantGate("dataset_already_active", g.id, g.email, sender())).disposition).toBe("skipped_capped");
  });

  it("the cap does not apply to the other requester kinds", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    for (let i = 0; i < 8; i++) await backdate(5, "dataset_verify", g.email);
    expect((await grantGate("dataset_approved", g.id, g.email, sender())).disposition).toBe("sent");
  });

  it("a concurrent burst of 8 never sends more than 5 (claim-first is conservative: claims all land before any count)", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    const send = sender();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => grantGate("dataset_already_active", g.id, g.email, send))
    );
    const sent = results.filter((r) => r.disposition === "sent").length;
    expect(sent).toBeLessThanOrEqual(DATASET_REQUESTER_CAP_MAX);
    expect(send).toHaveBeenCalledTimes(sent);
    expect(results.filter((r) => r.disposition === "skipped_capped")).toHaveLength(8 - sent);
    expect((await rows()).filter((r) => r.outcome === "sent")).toHaveLength(sent);
  });

  it("a cap lookup failure is gate_error, the claim settles as error/cap_check_failed, and nothing is sent", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = tdb.db.select.bind(tdb.db);
    vi.spyOn(tdb.db, "select").mockImplementation(((...args: unknown[]) => {
      const fields = args[0] as Record<string, unknown> | undefined;
      if (fields && "n" in fields) throw new Error("boom");
      return (orig as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const send = sender();
    const res = await grantGate("dataset_already_active", g.id, g.email, send);
    vi.restoreAllMocks();
    expect(res.disposition).toBe("gate_error");
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "cap_check_failed" });
  });

  it("daily cap: 10 in 24 h (only 2 in the last hour) caps the next send, shared across verify + already_active", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    for (let i = 0; i < 4; i++) await backdate(20 * 60, "dataset_verify", g.email);
    for (let i = 0; i < 4; i++) await backdate(10 * 60, "dataset_already_active", g.email);
    for (let i = 0; i < 2; i++) await backdate(30, "dataset_verify", g.email);
    const activeSend = sender();
    expect((await grantGate("dataset_already_active", g.id, g.email, activeSend)).disposition).toBe("skipped_capped");
    expect(activeSend).not.toHaveBeenCalled();
    await tdb.db.update(datasetAccessGrantsTable).set({ status: "unverified" }).where(eq(datasetAccessGrantsTable.id, g.id));
    const verifySend = sender();
    expect((await grantGate("dataset_verify", g.id, g.email, verifySend)).disposition).toBe("skipped_capped");
    expect(verifySend).not.toHaveBeenCalled();
    const capped = (await rows()).filter((r) => r.outcome === "skipped_capped");
    expect(capped).toHaveLength(2);
  });

  it("daily cap: rows older than 24 h and skipped rows do not count", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    for (let i = 0; i < 10; i++) await backdate(25 * 60, "dataset_verify", g.email);
    for (let i = 0; i < 10; i++) await backdate(10 * 60, "dataset_verify", g.email, "skipped_suppressed");
    const send = sender();
    expect((await grantGate("dataset_already_active", g.id, g.email, send)).disposition).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a daily count failure fails closed: gate_error, claim settles error/cap_check_failed, nothing sent", async () => {
    const g = await seedGrant({ lifecycle: "live" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = tdb.db.select.bind(tdb.db);
    let counts = 0;
    vi.spyOn(tdb.db, "select").mockImplementation(((...args: unknown[]) => {
      const fields = args[0] as Record<string, unknown> | undefined;
      // The hourly count (first) passes; only the 24-h count (second) throws.
      if (fields && "n" in fields && ++counts === 2) throw new Error("boom");
      return (orig as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const send = sender();
    const res = await grantGate("dataset_already_active", g.id, g.email, send);
    // The spy is restored by the file's afterEach, so a failed assertion cannot leak it.
    expect(counts).toBe(2);
    expect(res.disposition).toBe("gate_error");
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "cap_check_failed" });
  });

  it("claims BEFORE send: the attempted row exists while send() runs", async () => {
    const g = await seedGrant({ status: "unverified" });
    let seen: string[] = [];
    await grantGate("dataset_verify", g.id, g.email, async () => {
      seen = (await rows()).map((r) => r.outcome);
      return OK;
    });
    expect(seen).toEqual(["attempted"]);
  });
});

describe("sendDatasetAdminNoticeGated", () => {
  const MAINTAINER = "maintainer@example.com";
  const admin = (grantId: string, send: () => Promise<SendOutcome>, recipient = MAINTAINER) =>
    sendDatasetAdminNoticeGated(tdb.db, { grantId, recipient }, send);

  it("sends for pending_review and records the maintainer address, not the requester", async () => {
    const g = await seedGrant({ status: "pending_review" });
    const send = sender();
    expect(await admin(g.id, send)).toEqual({ sent: true, disposition: "sent" });
    const [row] = await rows();
    expect(row).toMatchObject({
      kind: "dataset_admin_new_request",
      outcome: "sent",
      subscriptionId: null,
      targetType: "dataset",
      targetId: g.id,
      emailHash: hashAddress(MAINTAINER),
    });
  });

  for (const status of STATUSES.filter((s) => s !== "pending_review")) {
    it(`${status} is skipped_unconfirmed`, async () => {
      const g = await seedGrant({ status });
      const send = sender();
      expect((await admin(g.id, send)).disposition).toBe("skipped_unconfirmed");
      expect(send).not.toHaveBeenCalled();
      expect((await rows())[0].outcome).toBe("skipped_unconfirmed");
    });
  }

  it("a vanished grant is skipped_unconfirmed", async () => {
    expect((await admin("00000000-0000-4000-8000-000000000000", sender())).disposition).toBe("skipped_unconfirmed");
  });

  it("a globally suppressed requester still produces the notice", async () => {
    const g = await seedGrant({ status: "pending_review" });
    await suppress(tdb.db, g.email, { kind: "global" }, "unsubscribe");
    expect((await admin(g.id, sender())).disposition).toBe("sent");
  });

  it("the 26th in 24 h across different grants is capped; old rows and skipped rows do not count", async () => {
    for (let i = 0; i < 10; i++) await backdate(25 * 60, "dataset_admin_new_request", MAINTAINER);
    for (let i = 0; i < 10; i++) await backdate(5, "dataset_admin_new_request", MAINTAINER, "skipped_unconfirmed");
    for (let i = 0; i < DATASET_ADMIN_NOTICE_CAP_MAX; i++) {
      const g = await seedGrant({ status: "pending_review" });
      expect((await admin(g.id, sender())).disposition).toBe("sent");
    }
    const g = await seedGrant({ status: "pending_review" });
    const send = sender();
    expect((await admin(g.id, send)).disposition).toBe("skipped_capped");
    expect(send).not.toHaveBeenCalled();
    // The grant itself is untouched: it still sits in the admin queue.
    const [after] = await tdb.db.select().from(datasetAccessGrantsTable).where(eq(datasetAccessGrantsTable.id, g.id));
    expect(after.status).toBe("pending_review");
  });

  it("an empty recipient sends nothing and writes no row", async () => {
    const g = await seedGrant({ status: "pending_review" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = sender();
    expect((await admin(g.id, send, "   ")).sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("a cap lookup failure fails closed", async () => {
    const g = await seedGrant({ status: "pending_review" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orig = tdb.db.select.bind(tdb.db);
    vi.spyOn(tdb.db, "select").mockImplementation(((...args: unknown[]) => {
      const fields = args[0] as Record<string, unknown> | undefined;
      if (fields && "n" in fields) throw new Error("boom");
      return (orig as (...a: unknown[]) => unknown)(...args);
    }) as never);
    const send = sender();
    const res = await admin(g.id, send);
    vi.restoreAllMocks();
    expect(res.disposition).toBe("gate_error");
    expect(send).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ outcome: "error", errorCode: "cap_check_failed" });
  });
});

describe("sendGated refuses dataset kinds", () => {
  it("sends nothing and records skipped_unconfirmed", async () => {
    const send = sender();
    for (const kind of ["dataset_verify", "dataset_admin_new_request", "dataset_approved"] as EmailSendKind[]) {
      const res = await sendGated(tdb.db, { kind, subscriptionId: "00000000-0000-4000-8000-000000000000", email: EMAIL }, send);
      expect(res).toEqual({ sent: false, disposition: "skipped_unconfirmed" });
    }
    expect(send).not.toHaveBeenCalled();
    expect((await rows()).map((r) => r.outcome)).toEqual(["skipped_unconfirmed", "skipped_unconfirmed", "skipped_unconfirmed"]);
  });
});
