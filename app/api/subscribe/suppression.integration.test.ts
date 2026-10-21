// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

let pendingAfter: Promise<unknown> | undefined;
// When set, `after()` tasks are parked instead of started, so a test can
// measure the work done BEFORE the response separately from the gated send.
let parkedAfter: (() => unknown) | undefined;
let parkAfter = false;
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      if (parkAfter) {
        parkedAfter = task;
        return;
      }
      pendingAfter = Promise.resolve().then(task);
    },
  };
});

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import { sql } from "drizzle-orm";

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { emailSuppressionsTable, subscriptionsTable } from "@/lib/db/schema";
import { __resetApiRateLimit } from "@/lib/api-rate-limit";
import { CONSENT_COOKIE_NAME, createConsentValue } from "@/lib/subscribe-consent";
import { isSuppressed, suppress } from "@/lib/suppressions";
import { hashToken } from "@/lib/token-hash";
import { isTokenRowUnsubscribed, stopAllStateByToken } from "@/lib/subscribe";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

import { POST as subscribePOST } from "./route";
import { GET as unsubGET, POST as unsubPOST } from "./unsubscribe/route";

const seedDoc = facilitiesRaw[0] as unknown as Facility;

let tdb: TestDbHandle;
let ipCounter = 0;

function subscribeReq(body: unknown, headers?: HeadersInit): Request {
  // A distinct IP per request keeps the per-IP subscribe budget out of the way.
  return new Request("http://localhost/api/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": `198.51.100.${(ipCounter++ % 250) + 1}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function unsubReq(
  method: "GET" | "POST",
  token: string,
  extra = "",
  ip = `203.0.113.${(ipCounter++ % 250) + 1}`
): Request {
  return new Request(
    `http://localhost/api/subscribe/unsubscribe?token=${encodeURIComponent(token)}${extra}`,
    { method, headers: { "x-real-ip": ip } }
  );
}

/** The page-form unsubscribe: a body-less POST (a GET no longer mutates). */
async function doUnsub(token: string): Promise<Response> {
  return unsubPOST(unsubReq("POST", token));
}

async function ageSuppressions(): Promise<void> {
  await tdb.db
    .update(emailSuppressionsTable)
    .set({ createdAt: new Date(Date.now() - 3_600_000) });
}

async function subscribe(email: string, targetType: "state" | "facility", targetId: string, headers?: HeadersInit) {
  const res = await subscribePOST(subscribeReq({ email, targetType, targetId }, headers));
  const body = await res.text();
  await pendingAfter;
  pendingAfter = undefined;
  return { status: res.status, body };
}

let seq = 0;
async function seedSub(
  email: string,
  targetType: string,
  targetId: string,
  status = "confirmed"
): Promise<string> {
  const unsubscribeToken = `tok-${++seq}-${Math.random().toString(36).slice(2)}`;
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType,
    targetId,
    status,
    confirmToken: `ct-${seq}-${Math.random().toString(36).slice(2)}`,
    unsubscribeToken,
  });
  return unsubscribeToken;
}

async function statusOf(token: string): Promise<string | undefined> {
  const rows = await tdb.db.select().from(subscriptionsTable);
  return rows.find((r) => r.unsubscribeToken === token)?.status;
}

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  __resetApiRateLimit();
  pendingAfter = undefined;
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("CONTRIBUTE_IP_SALT", "suppression-test-salt");
  await seedFacility(tdb.db, seedDoc);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
  __resetApiRateLimit();
});

describe("unsubscribe writes the suppression", () => {
  it("per-target unsubscribe suppresses that target only", async () => {
    const token = await seedSub("a@example.com", "state", "TN");
    const res = await doUnsub(token);
    expect(res.headers.get("location")).toContain("/subscribe/unsubscribed?token=");
    expect(await statusOf(token)).toBe("unsubscribed");
    expect(await isSuppressed(tdb.db, "a@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "suppressed"
    );
    expect(await isSuppressed(tdb.db, "a@example.com", { kind: "target", targetType: "state", targetId: "TX" })).toBe(
      "clear"
    );
  });

  it("writes the suppression BEFORE flipping the row (a failure in between leaves the person opted out)", async () => {
    const token = await seedSub("order@example.com", "state", "TN");
    // Make the status UPDATE fail; the suppression insert must already have landed.
    const db = tdb.db as unknown as { update: (...a: unknown[]) => unknown };
    const original = db.update.bind(tdb.db);
    db.update = () => {
      throw Object.assign(new Error("simulated update failure"), { code: "08006" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await doUnsub(token);
      expect(res.headers.get("location")).toContain("/subscribe/invalid");
    } finally {
      db.update = original;
      errSpy.mockRestore();
    }
    expect(await statusOf(token)).toBe("confirmed");
    expect(await isSuppressed(tdb.db, "order@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "suppressed"
    );
  });
});

describe("subscribe consults the suppression list", () => {
  it("re-subscribe after unsubscribe sends NO confirm mail and matches a fresh subscribe byte for byte", async () => {
    const fresh = await subscribe("fresh@example.com", "state", "TN");
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    resendSendMock.mockClear();

    const token = await seedSub("gone@example.com", "state", "TN");
    await doUnsub(token);

    const again = await subscribe("gone@example.com", "state", "TN");
    expect(again).toEqual(fresh);
    expect(resendSendMock).not.toHaveBeenCalled();
    const rows = (await tdb.db.select().from(subscriptionsTable)).filter((r) => r.email === "gone@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("unsubscribed");
  });

  it("a global suppression blocks every target, state and facility", async () => {
    const fresh = await subscribe("fresh@example.com", "state", "TN");
    resendSendMock.mockClear();
    await suppress(tdb.db, "global@example.com", { kind: "global" }, "unsubscribe_all");

    expect(await subscribe("global@example.com", "state", "TN")).toEqual(fresh);
    expect(await subscribe("global@example.com", "facility", seedDoc.id)).toMatchObject({ status: 201 });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await tdb.db.select().from(subscriptionsTable).then((r) => r.filter((x) => x.email === "global@example.com"))).toHaveLength(0);
  });

  it("an unreadable suppression list means no mail and the same response (unknown is not clear)", async () => {
    const fresh = await subscribe("fresh@example.com", "state", "TN");
    resendSendMock.mockClear();
    await tdb.db.execute(sql`alter table email_suppressions rename to email_suppressions_away`);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await subscribe("unk@example.com", "state", "TN")).toEqual(fresh);
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("isSuppressed lookup failed");
      expect(logged).not.toContain("unk@example.com");
    } finally {
      errSpy.mockRestore();
      await tdb.db.execute(sql`alter table email_suppressions_away rename to email_suppressions`);
    }
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("issues the same number of pre-response queries on the suppressed and the fresh path", async () => {
    const countSelects = async (email: string): Promise<number> => {
      const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown; insert: (...a: unknown[]) => unknown };
      const sel = db.select.bind(tdb.db);
      const ins = db.insert.bind(tdb.db);
      let n = 0;
      db.select = (...a: unknown[]) => {
        n++;
        return sel(...a);
      };
      db.insert = (...a: unknown[]) => {
        n++;
        return ins(...a);
      };
      // Counted up to the response only: the gated send runs after it (in
      // after()), so it cannot affect response timing, and its query count
      // legitimately differs by path (a suppressed address gets a skip row,
      // a fresh one an attempt row plus a settle).
      parkAfter = true;
      try {
        await subscribePOST(subscribeReq({ email, targetType: "state", targetId: "TN" }));
      } finally {
        parkAfter = false;
        db.select = sel;
        db.insert = ins;
      }
      const task = parkedAfter;
      parkedAfter = undefined;
      await task?.();
      return n;
    };
    await suppress(tdb.db, "blocked@example.com", { kind: "global" }, "unsubscribe_all");
    const fresh = await countSelects("new@example.com");
    const blocked = await countSelects("blocked@example.com");
    expect(blocked).toBe(fresh);
  });

  it("a valid consent cookie for the address lifts the target suppression and proceeds to a confirm mail", async () => {
    const token = await seedSub("back@example.com", "state", "TN");
    await doUnsub(token);
    await ageSuppressions(); // the cookie below postdates the opt-out
    resendSendMock.mockClear();

    const cookie = `${CONSENT_COOKIE_NAME}=${createConsentValue("back@example.com")}`;
    const res = await subscribe("back@example.com", "state", "TN", { cookie });
    expect(res.status).toBe(201);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(await isSuppressed(tdb.db, "back@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "clear"
    );
  });

  it("a consent cookie minted BEFORE the opt-out cannot undo it", async () => {
    const cookie = `${CONSENT_COOKIE_NAME}=${createConsentValue("fresh-optout@example.com")}`;
    const token = await seedSub("fresh-optout@example.com", "state", "TN");
    await doUnsub(token); // suppression is newer than the cookie
    resendSendMock.mockClear();

    await subscribe("fresh-optout@example.com", "state", "TN", { cookie });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(
      await isSuppressed(tdb.db, "fresh-optout@example.com", { kind: "target", targetType: "state", targetId: "TN" })
    ).toBe("suppressed");
  });

  it("a consent cookie for ANOTHER address lifts nothing", async () => {
    const token = await seedSub("victim@example.com", "state", "TN");
    await doUnsub(token);
    resendSendMock.mockClear();

    const cookie = `${CONSENT_COOKIE_NAME}=${createConsentValue("stranger@example.com")}`;
    await subscribe("victim@example.com", "state", "TN", { cookie });
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await isSuppressed(tdb.db, "victim@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "suppressed"
    );
  });
});

describe("stop-all link", () => {
  it("GET does not suppress or unsubscribe anything, and lands on the confirm page", async () => {
    const token = await seedSub("scan@example.com", "state", "TN");
    const res = await unsubGET(unsubReq("GET", token, "&scope=all"));
    expect(res.headers.get("location")).toContain("/subscribe/stop-all?token=");
    expect(await statusOf(token)).toBe("confirmed");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(0);
  });

  it("POST writes a global suppression and unsubscribes all of the address's rows", async () => {
    const t1 = await seedSub("all@example.com", "state", "TN");
    const t2 = await seedSub("all@example.com", "facility", seedDoc.id);
    const other = await seedSub("other@example.com", "state", "TN");

    const res = await unsubPOST(unsubReq("POST", t1, "&scope=all"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/stopped-all");
    expect(await statusOf(t1)).toBe("unsubscribed");
    expect(await statusOf(t2)).toBe("unsubscribed");
    expect(await statusOf(other)).toBe("confirmed");
    expect(await isSuppressed(tdb.db, "all@example.com", { kind: "target", targetType: "state", targetId: "ZZ" })).toBe(
      "suppressed"
    );
  });

  it("a forged token does nothing and matches the invalid-token redirect", async () => {
    const res = await unsubPOST(unsubReq("POST", "forged", "&scope=all"));
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(0);
  });
});

describe("Resume", () => {
  it("POST with a valid token lifts only its own target and restores the row", async () => {
    const tn = await seedSub("r@example.com", "state", "TN");
    const tx = await seedSub("r@example.com", "state", "TX");
    await doUnsub(tn);
    await doUnsub(tx);

    const res = await unsubPOST(unsubReq("POST", tn, "&action=resume"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/resumed");
    expect(await isSuppressed(tdb.db, "r@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "clear"
    );
    expect(await isSuppressed(tdb.db, "r@example.com", { kind: "target", targetType: "state", targetId: "TX" })).toBe(
      "suppressed"
    );
    expect(await statusOf(tn)).toBe("confirmed");
    expect(await statusOf(tx)).toBe("unsubscribed");
  });

  it("GET with action=resume changes nothing", async () => {
    const tn = await seedSub("g@example.com", "state", "TN");
    await doUnsub(tn);
    // A bare GET is the unsubscribe link, so it must not resume.
    await unsubGET(unsubReq("GET", tn, "&action=resume"));
    expect(await statusOf(tn)).toBe("unsubscribed");
    expect(await isSuppressed(tdb.db, "g@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "suppressed"
    );
  });

  it("a forged token does nothing and gets the same redirect as the invalid unsubscribe path", async () => {
    const tn = await seedSub("f@example.com", "state", "TN");
    await doUnsub(tn);
    const invalid = await doUnsub("nope");
    const res = await unsubPOST(unsubReq("POST", "nope", "&action=resume"));
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      new URL(invalid.headers.get("location")!).pathname
    );
    expect(await isSuppressed(tdb.db, "f@example.com", { kind: "target", targetType: "state", targetId: "TN" })).toBe(
      "suppressed"
    );
  });

  it("a per-target token cannot undo a global stop-all", async () => {
    const tn = await seedSub("s@example.com", "state", "TN");
    await unsubPOST(unsubReq("POST", tn, "&scope=all"));
    const res = await unsubPOST(unsubReq("POST", tn, "&action=resume"));
    expect(res.headers.get("location")).toContain("/subscribe/resumed?state=stopped");
    expect(await isSuppressed(tdb.db, "s@example.com", { kind: "global" })).toBe("suppressed");
  });
});

describe("List-Unsubscribe on the subscription mail", () => {
  it("is present on watch-started mail (auto-confirm), with the stop-all link in the body", async () => {
    await seedSub("known@example.com", "state", "CA");
    const cookie = `${CONSENT_COOKIE_NAME}=${createConsentValue("known@example.com")}`;
    await subscribe("known@example.com", "state", "TN", { cookie });
    const args = resendSendMock.mock.calls[0][0];
    expect(args.headers["List-Unsubscribe"]).toBeTruthy();
    expect(args.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(args.text).toContain("Stop all automated email from Compute Atlas");
  });
});

describe("Resume statuses", () => {
  async function resume(token: string): Promise<string> {
    const res = await unsubPOST(unsubReq("POST", token, "&action=resume"));
    expect(res.status).toBe(303);
    return res.headers.get("location")!;
  }

  it("resumed: row restored, suppression lifted", async () => {
    const t = await seedSub("a@example.com", "state", "TN");
    await doUnsub(t);
    expect(await resume(t)).toMatch(/\/subscribe\/resumed$/);
    expect(await statusOf(t)).toBe("confirmed");
  });

  it("already active: nothing to restore", async () => {
    const t = await seedSub("b@example.com", "state", "TN");
    expect(await resume(t)).toContain("/subscribe/resumed?state=active");
  });

  it("already active on a 23505 conflict with another active row for the target", async () => {
    const old = await seedSub("c@example.com", "state", "TN");
    await doUnsub(old);
    await seedSub("c@example.com", "state", "TN"); // a fresh active row for the same target
    expect(await resume(old)).toContain("/subscribe/resumed?state=active");
    expect(await statusOf(old)).toBe("unsubscribed");
    expect(
      await isSuppressed(tdb.db, "c@example.com", { kind: "target", targetType: "state", targetId: "TN" })
    ).toBe("clear");
  });

  it("still stopped: a global suppression survives, and the page must not promise alerts", async () => {
    const t = await seedSub("d@example.com", "state", "TN");
    await doUnsub(t);
    await suppress(tdb.db, "d@example.com", { kind: "global" }, "unsubscribe_all");
    expect(await resume(t)).toContain("/subscribe/resumed?state=stopped");
    expect(await isSuppressed(tdb.db, "d@example.com", { kind: "global" })).toBe("suppressed");
  });

  it("a lift that throws AFTER the row was restored reports lift_failed (retry), not invalid", async () => {
    const t = await seedSub("lf@example.com", "state", "TN");
    await doUnsub(t);
    const db = tdb.db as unknown as { delete: (...a: unknown[]) => unknown };
    const original = db.delete.bind(tdb.db);
    db.delete = () => {
      throw Object.assign(new Error("boom lf@example.com"), { code: "08006" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resume(t)).toContain("/subscribe/resumed?state=retry");
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("sqlstate: 08006");
      expect(logged).not.toContain("lf@example.com");
    } finally {
      db.delete = original;
      errSpy.mockRestore();
    }
    expect(await statusOf(t)).toBe("confirmed");
    // A second press finishes the job.
    expect(await resume(t)).toMatch(/\/subscribe\/resumed(\?state=active)?$/);
    expect(
      await isSuppressed(tdb.db, "lf@example.com", { kind: "target", targetType: "state", targetId: "TN" })
    ).toBe("clear");
  });

  it("a DB failure while restoring is invalid, not success, and lifts nothing", async () => {
    const t = await seedSub("e@example.com", "state", "TN");
    await doUnsub(t);
    const db = tdb.db as unknown as { update: (...a: unknown[]) => unknown };
    const original = db.update.bind(tdb.db);
    db.update = () => {
      throw Object.assign(new Error("boom"), { code: "08006" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resume(t)).toContain("/subscribe/invalid");
    } finally {
      db.update = original;
      errSpy.mockRestore();
    }
    expect(
      await isSuppressed(tdb.db, "e@example.com", { kind: "target", targetType: "state", targetId: "TN" })
    ).toBe("suppressed");
    expect(await statusOf(t)).toBe("unsubscribed");
  });

  it("a DB failure while reading the token is invalid", async () => {
    const t = await seedSub("f2@example.com", "state", "TN");
    await doUnsub(t);
    const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown };
    const original = db.select.bind(tdb.db);
    db.select = () => {
      throw Object.assign(new Error("boom"), { code: "08006" });
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resume(t)).toContain("/subscribe/invalid");
    } finally {
      db.select = original;
      errSpy.mockRestore();
    }
  });
});

describe("Undo stop-all", () => {
  const undo = (token: string) => unsubPOST(unsubReq("POST", token, "&scope=all&action=undo"));

  it("the token that stopped all automated email undoes it; per-watch rows stay unsubscribed", async () => {
    const t1 = await seedSub("u@example.com", "state", "TN");
    await unsubPOST(unsubReq("POST", t1, "&scope=all"));
    const [row] = await tdb.db.select().from(emailSuppressionsTable);
    expect(row.sourceTokenHash).toBe(hashToken(t1));
    expect(row.sourceTokenHash).not.toContain(t1);

    const res = await undo(t1);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/subscribe/undone");
    expect(await isSuppressed(tdb.db, "u@example.com", { kind: "global" })).toBe("clear");
    expect(await statusOf(t1)).toBe("unsubscribed");
  });

  it("a different valid token for the same address cannot undo it", async () => {
    const t1 = await seedSub("v@example.com", "state", "TN");
    const t2 = await seedSub("v@example.com", "facility", seedDoc.id);
    await unsubPOST(unsubReq("POST", t1, "&scope=all"));

    const res = await undo(t2);
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
    expect(await isSuppressed(tdb.db, "v@example.com", { kind: "global" })).toBe("suppressed");
  });

  it("a second stop-all with another token keeps the FIRST token as the undo key", async () => {
    const t1 = await seedSub("w@example.com", "state", "TN");
    const t2 = await seedSub("w@example.com", "facility", seedDoc.id);
    await unsubPOST(unsubReq("POST", t1, "&scope=all"));
    await unsubPOST(unsubReq("POST", t2, "&scope=all"));
    const [row] = await tdb.db.select().from(emailSuppressionsTable);
    expect(row.sourceTokenHash).toBe(hashToken(t1));
    expect((await undo(t2)).headers.get("location")).toContain("/subscribe/invalid");
    expect((await undo(t1)).headers.get("location")).toContain("/subscribe/undone");
  });

  it("a global row with a NULL hash (backfill/admin) cannot be lifted by any token", async () => {
    const t = await seedSub("x@example.com", "state", "TN");
    await suppress(tdb.db, "x@example.com", { kind: "global" }, "admin");
    expect((await undo(t)).headers.get("location")).toContain("/subscribe/invalid");
    expect(await isSuppressed(tdb.db, "x@example.com", { kind: "global" })).toBe("suppressed");
  });

  it("a GET (prefetch) of the undo link changes nothing and lands on the Undo page", async () => {
    const t = await seedSub("y@example.com", "state", "TN");
    await unsubPOST(unsubReq("POST", t, "&scope=all"));
    for (let i = 0; i < 2; i++) {
      const res = await unsubGET(unsubReq("GET", t, "&scope=all&action=undo"));
      expect(res.headers.get("location")).toContain("/subscribe/stopped-all?token=");
    }
    expect(await isSuppressed(tdb.db, "y@example.com", { kind: "global" })).toBe("suppressed");
  });

  it("reopening the stop-all link: the token that did it is sent to Undo, another token to 'already stopped', all by READ", async () => {
    const t1 = await seedSub("o@example.com", "state", "TN");
    const t2 = await seedSub("o@example.com", "facility", seedDoc.id);
    // Not stopped yet: the confirm page, for a valid and an unknown token alike (no oracle).
    expect((await unsubGET(unsubReq("GET", t1, "&scope=all"))).headers.get("location")).toContain("/subscribe/stop-all?token=");
    expect((await unsubGET(unsubReq("GET", "unknown-token", "&scope=all"))).headers.get("location")).toContain("/subscribe/stop-all?token=");

    await unsubPOST(unsubReq("POST", t1, "&scope=all"));
    for (const extra of ["&scope=all", "&scope=all&action=undo"]) {
      expect((await unsubGET(unsubReq("GET", t1, extra))).headers.get("location")).toContain("/subscribe/stopped-all?token=");
      expect((await unsubGET(unsubReq("GET", t2, extra))).headers.get("location")).toContain("/subscribe/stopped-all?state=other");
    }
    expect((await unsubGET(unsubReq("GET", "unknown-token", "&scope=all"))).headers.get("location")).toContain("/subscribe/stop-all?token=");
    // Reads only: still stopped, same single row.
    expect(await isSuppressed(tdb.db, "o@example.com", { kind: "global" })).toBe("suppressed");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(1);
  });

  it("a stop-all POST with a SECOND token goes to 'already stopped' (no Undo token in the URL), keeping first-wins", async () => {
    const t1 = await seedSub("p@example.com", "state", "TN");
    const t2 = await seedSub("p@example.com", "facility", seedDoc.id);
    const first = await unsubPOST(unsubReq("POST", t1, "&scope=all"));
    expect(first.headers.get("location")).toContain("/subscribe/stopped-all?token=");
    const second = await unsubPOST(unsubReq("POST", t2, "&scope=all"));
    expect(second.headers.get("location")).toContain("/subscribe/stopped-all?state=other");
    expect(second.headers.get("location")).not.toContain("token");
    const [row] = await tdb.db.select().from(emailSuppressionsTable);
    expect(row.sourceTokenHash).toBe(hashToken(t1));
  });

  it("a one-click body on the undo URL does not stop-all or undo anything", async () => {
    const t = await seedSub("z@example.com", "state", "TN");
    const res = await unsubPOST(
      new Request(`http://localhost/api/subscribe/unsubscribe?token=${t}&scope=all&action=undo`, {
        method: "POST",
        headers: { "x-real-ip": "203.0.113.200" },
        body: "List-Unsubscribe=One-Click",
      })
    );
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
    expect(await tdb.db.select().from(emailSuppressionsTable)).toHaveLength(0);
  });

  it("a forged token does nothing", async () => {
    const res = await undo("forged");
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
  });
});

describe("round-5 reads and edge cases", () => {
  it("isTokenRowUnsubscribed reflects the row and treats unknown tokens as active", async () => {
    const t = await seedSub("rd@example.com", "state", "TN");
    expect(await isTokenRowUnsubscribed(t)).toBe(false);
    await doUnsub(t);
    expect(await isTokenRowUnsubscribed(t)).toBe(true);
    expect(await isTokenRowUnsubscribed("nope")).toBe(false);
  });

  it("resume on a PENDING row is invalid, not 'already active'", async () => {
    const t = await seedSub("pend@example.com", "state", "TN", "pending");
    const res = await unsubPOST(unsubReq("POST", t, "&action=resume"));
    expect(res.headers.get("location")).toContain("/subscribe/invalid");
  });

  it("stopAllStateByToken costs the same two queries for an unknown token and a known one", async () => {
    const t = await seedSub("cost@example.com", "state", "TN");
    const count = async (token: string) => {
      const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown };
      const sel = db.select.bind(tdb.db);
      let n = 0;
      db.select = (...a: unknown[]) => {
        n++;
        return sel(...a);
      };
      try {
        await stopAllStateByToken(token);
      } finally {
        db.select = sel;
      }
      return n;
    };
    expect(await count("unknown-token")).toBe(await count(t));
    expect(await count(t)).toBe(2);
  });

  it("if the post-stop lookup fails, the person who just stopped everything still lands on the Undo page", async () => {
    const t = await seedSub("er@example.com", "state", "TN");
    const db = tdb.db as unknown as { select: (...a: unknown[]) => unknown };
    const sel = db.select.bind(tdb.db);
    let calls = 0;
    // 1st select = token row lookup in unsubscribeAllByToken; then the state lookup (2 selects) must fail.
    db.select = (...a: unknown[]) => {
      calls++;
      if (calls >= 2) throw Object.assign(new Error("boom"), { code: "08006" });
      return sel(...a);
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let res: Response;
    try {
      res = await unsubPOST(unsubReq("POST", t, "&scope=all"));
    } finally {
      db.select = sel;
      errSpy.mockRestore();
    }
    expect(res.headers.get("location")).toContain("/subscribe/stopped-all?token=");
  });
});
