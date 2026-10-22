// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";

import { emailSuppressionsTable, subscriptionsTable } from "@/lib/db/schema";
import {
  inboxProofFromConsentCookie,
  inboxProofFromUnsubscribeToken,
  isSuppressed,
  lift,
  subscriptionSuppressedSql,
  CONSENT_LIFT_SKEW_MS,
  mayEmail,
  type SuppressionScope,
  suppress,
  type InboxProof,
  type SuppressionDb,
} from "@/lib/suppressions";
import { createConsentValue } from "@/lib/subscribe-consent";
import { hashToken } from "@/lib/token-hash";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

let tdb: TestDbHandle;
let db: SuppressionDb;

const MIGRATION = readFileSync(join(process.cwd(), "drizzle/0016_quiet_ledger.sql"), "utf-8");
const statements = MIGRATION.split("--> statement-breakpoint").map((s) => s.trim());

beforeAll(async () => {
  process.env.CONTRIBUTE_IP_SALT = "test-salt-for-suppressions";
  tdb = await makeTestDb();
  db = tdb.db;
});

beforeEach(async () => {
  await tdb.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await tdb.client.close();
});

let n = 0;
async function seedSub(
  email: string,
  status: string,
  targetType = "facility",
  targetId: string | null = "alpha"
): Promise<string> {
  const unsubscribeToken = `unsub-${++n}`;
  await db.insert(subscriptionsTable).values({
    email,
    targetType,
    targetId,
    status,
    confirmToken: `confirm-${n}`,
    unsubscribeToken,
  });
  return unsubscribeToken;
}

async function rowCount(): Promise<number> {
  return (await db.select().from(emailSuppressionsTable)).length;
}

describe("migration 0016", () => {
  it("applies cleanly a second time (idempotent)", async () => {
    for (const stmt of statements) {
      await tdb.client.exec(stmt);
    }
    for (const stmt of statements) {
      await tdb.client.exec(stmt);
    }
    expect(await rowCount()).toBe(0);
  });

  it("backfills unsubscribed rows only, normalized, once", async () => {
    await seedSub("  Gone@Example.com ", "unsubscribed", "facility", "alpha");
    await seedSub("gone@example.com", "unsubscribed", "state", "VA");
    await seedSub("gone@example.com", "unsubscribed", "all", null);
    await seedSub("kept@example.com", "confirmed");
    await seedSub("wait@example.com", "pending");

    const backfill = statements[statements.length - 1];
    expect(backfill).toContain("INSERT INTO");
    await tdb.client.exec(backfill);
    await tdb.client.exec(backfill);

    const rows = await db.select().from(emailSuppressionsTable);
    expect(rows.map((r) => `${r.email}|${r.targetType}|${r.targetId}|${r.source}`).sort()).toEqual([
      "gone@example.com|all||backfill",
      "gone@example.com|facility|alpha|backfill",
      "gone@example.com|state|VA|backfill",
    ]);
  });
});

const facility = (targetId: string): SuppressionScope => ({
  kind: "target",
  targetType: "facility",
  targetId,
});
const state = (targetId: string): SuppressionScope => ({
  kind: "target",
  targetType: "state",
  targetId,
});
const area = (targetType: "county" | "metro", targetId: string): SuppressionScope => ({
  kind: "target",
  targetType,
  targetId,
});
const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
/** Pins only Date, so PGlite's timers keep working. */
const at = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + ms);
};
const GLOBAL: SuppressionScope = { kind: "global" };

describe("isSuppressed", () => {
  it("is clear for an unknown address", async () => {
    expect(await isSuppressed(db, "a@example.com", facility("alpha"))).toBe("clear");
  });

  it("per-target row matches only that exact target", async () => {
    await suppress(db, "a@example.com", facility("alpha"), "unsubscribe");
    expect(await isSuppressed(db, "a@example.com", facility("alpha"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", facility("beta"))).toBe("clear");
    expect(await isSuppressed(db, "a@example.com", state("alpha"))).toBe("clear");
    expect(await isSuppressed(db, "a@example.com", GLOBAL)).toBe("clear");
    expect(await isSuppressed(db, "b@example.com", facility("alpha"))).toBe("clear");
  });

  it("global row suppresses every target", async () => {
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    expect(await isSuppressed(db, "a@example.com", facility("alpha"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", state("VA"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", GLOBAL)).toBe("suppressed");
    expect(await isSuppressed(db, "b@example.com", state("VA"))).toBe("clear");
  });

  it("normalizes case and whitespace on both write and read", async () => {
    await suppress(db, "  MiXed@Example.COM ", GLOBAL, "admin");
    expect(await isSuppressed(db, "mixed@example.com", state("VA"))).toBe("suppressed");
    expect(await isSuppressed(db, " MIXED@example.com\n", state("VA"))).toBe("suppressed");
    const [row] = await db.select().from(emailSuppressionsTable);
    expect(row.email).toBe("mixed@example.com");
  });

  it("normalizes target ids: state codes uppercase, ids trimmed", async () => {
    await suppress(db, "a@example.com", state(" va "), "unsubscribe");
    await suppress(db, "a@example.com", facility("  alpha "), "unsubscribe");
    const rows = await db.select().from(emailSuppressionsTable);
    expect(rows.map((r) => `${r.targetType}|${r.targetId}`).sort()).toEqual([
      "facility|alpha",
      "state|VA",
    ]);
    expect(await isSuppressed(db, "a@example.com", state("VA"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", state("va"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", facility(" alpha"))).toBe("suppressed");
  });

  it("normalizes county and metro slugs to lowercase, so \"Loudoun-VA\" matches a row stored as \"loudoun-va\"", async () => {
    await suppress(db, "a@example.com", area("county", " Loudoun-VA "), "unsubscribe");
    await suppress(db, "a@example.com", area("metro", "Northern-Virginia"), "unsubscribe");
    const rows = await db.select().from(emailSuppressionsTable);
    expect(rows.map((r) => `${r.targetType}|${r.targetId}`).sort()).toEqual([
      "county|loudoun-va",
      "metro|northern-virginia",
    ]);
    expect(await isSuppressed(db, "a@example.com", area("county", "loudoun-va"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", area("county", "LOUDOUN-VA"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", area("metro", "NORTHERN-VIRGINIA"))).toBe("suppressed");
    expect(await isSuppressed(db, "a@example.com", area("county", "fairfax-va"))).toBe("clear");
  });

  it("returns unknown (never clear) when the lookup errors, logging SQLSTATE only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      select: () => {
        throw Object.assign(new Error("secret@example.com leaked"), {
          code: "42P01",
        });
      },
    } as unknown as SuppressionDb;
    expect(await isSuppressed(broken, "secret@example.com", facility("alpha"))).toBe("unknown");
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("isSuppressed lookup failed");
    expect(logged).toContain("42P01");
    expect(logged).not.toContain("secret@example.com");
    spy.mockRestore();
  });
});

describe("isSuppressed invalid scope", () => {
  it("fails closed as unknown with a distinct log line, no lookup-failed line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isSuppressed(db, "a@example.com", state(""))).toBe("unknown");
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("isSuppressed invalid scope (caller bug)");
    expect(logged).not.toContain("lookup failed");
    spy.mockRestore();
  });
});

describe("mayEmail", () => {
  it("is true only for clear", () => {
    expect(mayEmail("clear")).toBe(true);
    expect(mayEmail("suppressed")).toBe(false);
    expect(mayEmail("unknown")).toBe(false);
  });
});

describe("suppress", () => {
  it("is idempotent, including the first source winning", async () => {
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    await suppress(db, "A@example.com", state("VA"), "admin");
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    const rows = await db.select().from(emailSuppressionsTable);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.targetType === "state")?.source).toBe("unsubscribe");
  });

  it("rejects a target scope with an empty half rather than writing a global row", async () => {
    await expect(suppress(db, "a@example.com", state(""), "admin")).rejects.toThrow();
    await expect(suppress(db, "a@example.com", state("  "), "admin")).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });
});

describe("lift", () => {
  const cookieProof = (email: string): InboxProof => {
    const p = inboxProofFromConsentCookie(createConsentValue(email), email);
    expect(p).not.toBeNull();
    return p as InboxProof;
  };

  it("refuses a forged proof (cast object, bare boolean) and deletes nothing", async () => {
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    const forged = {
      email: "a@example.com",
      via: "consent_cookie",
    } as unknown as InboxProof;
    expect(await lift(db, "a@example.com", GLOBAL, forged)).toBe(false);
    expect(await lift(db, "a@example.com", GLOBAL, true as unknown as InboxProof)).toBe(false);
    expect(await rowCount()).toBe(1);
  });

  it("refuses a genuine proof for a DIFFERENT address", async () => {
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    expect(await lift(db, "a@example.com", GLOBAL, cookieProof("b@example.com"))).toBe(false);
    expect(await rowCount()).toBe(1);
  });

  it("consent-cookie proof lifts exactly the named row, target or global", async () => {
    at(0);
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    at(10_000); // cookie must postdate the global row by more than the skew margin
    const proof = inboxProofFromConsentCookie(
      createConsentValue("a@example.com"),
      " A@example.com "
    );
    expect(proof).not.toBeNull();
    expect(await lift(db, "a@example.com", state("VA"), proof as InboxProof)).toBe(true);
    expect(await isSuppressed(db, "a@example.com", state("VA"))).toBe("suppressed"); // global remains
    expect(await lift(db, "a@example.com", GLOBAL, proof as InboxProof)).toBe(true);
    expect(await isSuppressed(db, "a@example.com", state("VA"))).toBe("clear");
  });

  it("a cookie issued before, or within the skew margin after, the global row cannot lift it", async () => {
    at(0);
    const before = cookieProof("a@example.com");
    at(1000);
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    expect(await lift(db, "a@example.com", GLOBAL, before)).toBe(false);
    at(2000); // 1 s after the row
    const soon = cookieProof("a@example.com");
    expect(await lift(db, "a@example.com", GLOBAL, soon)).toBe(false);
    expect(await isSuppressed(db, "a@example.com", GLOBAL)).toBe("suppressed");
    at(1000 + CONSENT_LIFT_SKEW_MS); // exactly the margin after the row: still refused
    const boundary = cookieProof("a@example.com");
    expect(await lift(db, "a@example.com", GLOBAL, boundary)).toBe(false);
    at(1000 + CONSENT_LIFT_SKEW_MS + 1000); // 6 s after the row
    const later = cookieProof("a@example.com");
    expect(await lift(db, "a@example.com", GLOBAL, later)).toBe(true);
    expect(await isSuppressed(db, "a@example.com", GLOBAL)).toBe("clear");
  });

  it("an older (or within-skew) cookie cannot lift a TARGET row; a later one can", async () => {
    at(0);
    const before = cookieProof("a@example.com");
    at(1000);
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    expect(await lift(db, "a@example.com", state("VA"), before)).toBe(false);
    at(1000 + CONSENT_LIFT_SKEW_MS); // exactly the margin: still refused
    expect(await lift(db, "a@example.com", state("VA"), cookieProof("a@example.com"))).toBe(false);
    expect(await isSuppressed(db, "a@example.com", state("VA"))).toBe("suppressed");
    at(1000 + CONSENT_LIFT_SKEW_MS + 1000);
    expect(await lift(db, "a@example.com", state("VA"), cookieProof("a@example.com"))).toBe(true);
  });

  it("a TOKEN grant lifts a target row regardless of age (the Resume path)", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "state", "VA");
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    const proof = (await inboxProofFromUnsubscribeToken(db, token)) as InboxProof;
    expect(await lift(db, "a@example.com", state("VA"), proof)).toBe(true);
  });

  it("returns false when no matching row exists", async () => {
    expect(await lift(db, "a@example.com", state("VA"), cookieProof("a@example.com"))).toBe(false);
  });

  it("no proof from a cookie for another address or a missing/garbage cookie", () => {
    const other = createConsentValue("b@example.com");
    expect(inboxProofFromConsentCookie(other, "a@example.com")).toBeNull();
    expect(inboxProofFromConsentCookie(undefined, "a@example.com")).toBeNull();
    expect(inboxProofFromConsentCookie("garbage", "a@example.com")).toBeNull();
  });

  it("token for an UNSUBSCRIBED row lifts its own target (the Resume case)", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "state", "VA");
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    expect(await inboxProofFromUnsubscribeToken(db, "nope")).toBeNull();
    expect(await inboxProofFromUnsubscribeToken(db, "")).toBeNull();
    const proof = (await inboxProofFromUnsubscribeToken(db, token)) as InboxProof;
    expect(proof).not.toBeNull();
    expect(await lift(db, "someone-else@example.com", state("VA"), proof)).toBe(false);
    expect(await lift(db, "a@example.com", state("VA"), proof)).toBe(true);
  });

  it("a target token cannot lift the global row", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "state", "VA");
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all");
    const proof = (await inboxProofFromUnsubscribeToken(db, token)) as InboxProof;
    expect(await lift(db, "a@example.com", GLOBAL, proof)).toBe(false);
    expect(await isSuppressed(db, "a@example.com", GLOBAL)).toBe("suppressed");
  });

  it("a target token cannot lift a different target", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "state", "VA");
    await suppress(db, "a@example.com", state("TX"), "unsubscribe");
    await suppress(db, "a@example.com", facility("VA"), "unsubscribe");
    const proof = (await inboxProofFromUnsubscribeToken(db, token)) as InboxProof;
    expect(await lift(db, "a@example.com", state("TX"), proof)).toBe(false);
    expect(await lift(db, "a@example.com", facility("VA"), proof)).toBe(false);
    expect(await rowCount()).toBe(2);
  });

  it("token proof scope is normalized (lowercase stored state code still matches)", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "state", "va");
    await suppress(db, "a@example.com", state("VA"), "unsubscribe");
    const proof = (await inboxProofFromUnsubscribeToken(db, token)) as InboxProof;
    expect(await lift(db, "a@example.com", state("VA"), proof)).toBe(true);
  });

  it("token lookup DB error yields no proof and logs SQLSTATE only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      select: () => {
        throw Object.assign(new Error("a@example.com leaked"), {
          code: "08006",
        });
      },
    } as unknown as SuppressionDb;
    expect(await inboxProofFromUnsubscribeToken(broken, "tok")).toBeNull();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain("a@example.com");
    spy.mockRestore();
  });

  it("the retired 'all' target yields no token proof and logs nothing", async () => {
    const token = await seedSub("a@example.com", "unsubscribed", "all", null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await inboxProofFromUnsubscribeToken(db, token)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("subscriptionSuppressedSql", () => {
  it("flags only the suppressed subscription rows (table-qualified correlation)", async () => {
    await seedSub("out@example.com", "confirmed", "state", "VA");
    await seedSub("in@example.com", "confirmed", "state", "VA");
    await seedSub("other@example.com", "confirmed", "state", "TX");
    await suppress(db, "out@example.com", state("VA"), "unsubscribe");
    await suppress(db, "other@example.com", state("VA"), "unsubscribe"); // different target than its row
    const rows = await db
      .select({ email: subscriptionsTable.email, blocked: subscriptionSuppressedSql() })
      .from(subscriptionsTable);
    expect(Object.fromEntries(rows.map((r) => [r.email, r.blocked]))).toEqual({
      "out@example.com": true,
      "in@example.com": false,
      "other@example.com": false,
    });
  });

  // Pins WHY the helper uses raw qualified identifiers: drizzle drops the table
  // prefix from interpolated columns in a single-table query, so the naive form
  // correlates the inner reference with itself and matches EVERY row. If this
  // ever stops being true the raw identifiers are no longer needed.
  it("the naive interpolated-column form matches every row (the bug the raw identifiers avoid)", async () => {
    await seedSub("out@example.com", "confirmed", "state", "VA");
    await seedSub("in@example.com", "confirmed", "state", "VA");
    await suppress(db, "out@example.com", state("VA"), "unsubscribe");
    const naive = sql<boolean>`exists (
      select 1 from "email_suppressions" "es"
      where ${emailSuppressionsTable.email} = lower(${subscriptionsTable.email})
    )`;
    const rows = await db
      .select({ email: subscriptionsTable.email, blocked: naive })
      .from(subscriptionsTable);
    expect(rows.every((r) => r.blocked)).toBe(true);
  });
});

describe("token grant on the GLOBAL row (Undo)", () => {
  it("lifts it only for the token whose hash is stored; the first stop-all's hash wins", async () => {
    const t1 = await seedSub("a@example.com", "confirmed", "state", "VA");
    const t2 = await seedSub("a@example.com", "confirmed", "state", "TX");
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all", hashToken(t1));
    await suppress(db, "a@example.com", GLOBAL, "unsubscribe_all", hashToken(t2)); // conflict: ignored
    const p2 = (await inboxProofFromUnsubscribeToken(db, t2)) as InboxProof;
    expect(await lift(db, "a@example.com", GLOBAL, p2)).toBe(false);
    const p1 = (await inboxProofFromUnsubscribeToken(db, t1)) as InboxProof;
    expect(await lift(db, "a@example.com", GLOBAL, p1)).toBe(true);
  });

  it("never lifts a NULL-hash global row, and a token never lifts another address's row", async () => {
    const t = await seedSub("a@example.com", "confirmed", "state", "VA");
    await suppress(db, "a@example.com", GLOBAL, "admin");
    await suppress(db, "b@example.com", GLOBAL, "unsubscribe_all", hashToken(t));
    const p = (await inboxProofFromUnsubscribeToken(db, t)) as InboxProof;
    expect(await lift(db, "a@example.com", GLOBAL, p)).toBe(false);
    expect(await lift(db, "b@example.com", GLOBAL, p)).toBe(false);
    expect(await rowCount()).toBe(2);
  });

  it("the migration adds a nullable source_token_hash and the backfill leaves it NULL", async () => {
    await seedSub("gone@example.com", "unsubscribed", "state", "VA");
    await tdb.client.exec(statements[statements.length - 1]);
    const rows = await db.select().from(emailSuppressionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceTokenHash).toBeNull();
  });
});
