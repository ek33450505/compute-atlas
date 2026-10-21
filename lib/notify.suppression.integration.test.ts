// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client");

const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import { sql } from "drizzle-orm";

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilityHistoryTable, subscriptionsTable } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { suppress } from "@/lib/suppressions";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

import {
  notifyStateSubscribersMonthly,
  notifySubscribersOfChange,
  notifySubscribersOfChanges,
} from "@/lib/notify";

const facilities = facilitiesRaw as unknown as Facility[];
const facilityA = facilities[0];
const facilityB = facilities.find((f) => f.id !== facilityA.id)!;
const state = facilityA.location.state;

const since = new Date("2026-01-01T00:00:00Z");
const until = new Date("2026-02-01T00:00:00Z");

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
});

beforeEach(async () => {
  await tdb.reset();
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "m-1" }, error: null });
  vi.stubEnv("RESEND_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

async function sub(email: string, targetType: "facility" | "state", targetId: string): Promise<string> {
  const unsubscribeToken = generateToken();
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType,
    targetId,
    status: "confirmed",
    confirmToken: generateToken(),
    unsubscribeToken,
  });
  return unsubscribeToken;
}

function sentTo(): string[] {
  return resendSendMock.mock.calls.map((c) => c[0].to as string);
}

describe("notify skips suppressed recipients", () => {
  it("single-facility notify: a target-suppressed subscriber is skipped, others are mailed", async () => {
    await sub("out@example.com", "facility", facilityA.id);
    await sub("in@example.com", "facility", facilityA.id);
    await suppress(tdb.db, "out@example.com", { kind: "target", targetType: "facility", targetId: facilityA.id }, "unsubscribe");

    await notifySubscribersOfChange(facilityA, "record updated");
    expect(sentTo()).toEqual(["in@example.com"]);
  });

  it("a suppression for a DIFFERENT target does not block", async () => {
    await sub("x@example.com", "facility", facilityA.id);
    await suppress(tdb.db, "x@example.com", { kind: "target", targetType: "facility", targetId: facilityB.id }, "unsubscribe");

    await notifySubscribersOfChange(facilityA, "record updated");
    expect(sentTo()).toEqual(["x@example.com"]);
  });

  it("batched notify: a global suppression skips every one of the address's rows", async () => {
    await sub("g@example.com", "facility", facilityA.id);
    await sub("g@example.com", "facility", facilityB.id);
    await sub("ok@example.com", "facility", facilityA.id);
    await suppress(tdb.db, "g@example.com", { kind: "global" }, "unsubscribe_all");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "a" },
      { facility: facilityB, changeLabel: "b" },
    ]);
    expect(sentTo()).toEqual(["ok@example.com"]);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("skipped 2 suppressed");
    expect(logged).not.toContain("@");
  });

  it("state digest: a suppressed state subscriber is skipped", async () => {
    await seedFacility(tdb.db, facilityA);
    await tdb.db.insert(facilityHistoryTable).values({
      facilityId: facilityA.id,
      changeType: "update",
      changedAt: new Date("2026-01-15T00:00:00Z"),
      diff: [],
      source: "test",
    });
    await sub("out@example.com", "state", state);
    await sub("in@example.com", "state", state);
    await suppress(tdb.db, "out@example.com", { kind: "target", targetType: "state", targetId: state }, "unsubscribe");

    await notifyStateSubscribersMonthly(since, until);
    expect(sentTo()).toEqual(["in@example.com"]);
  });

  it("unknown means no send: an unreadable suppression list mails nobody", async () => {
    await sub("a@example.com", "facility", facilityA.id);
    await tdb.db.execute(sql`alter table email_suppressions rename to email_suppressions_away`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notifySubscribersOfChange(facilityA, "record updated");
      await notifySubscribersOfChanges([{ facility: facilityA, changeLabel: "a" }]);
    } finally {
      await tdb.db.execute(sql`alter table email_suppressions_away rename to email_suppressions`);
    }
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("List-Unsubscribe headers", () => {
  it("is on the single-change, the multi-change digest and the state digest senders", async () => {
    // single-change
    await sub("one@example.com", "facility", facilityA.id);
    await notifySubscribersOfChange(facilityA, "record updated");
    // multi-change digest
    await sub("many@example.com", "facility", facilityA.id);
    await sub("many@example.com", "facility", facilityB.id);
    await notifySubscribersOfChanges([
      { facility: facilityA, changeLabel: "a" },
      { facility: facilityB, changeLabel: "b" },
    ]);
    // state digest
    await seedFacility(tdb.db, facilityA);
    await tdb.db.insert(facilityHistoryTable).values({
      facilityId: facilityA.id,
      changeType: "update",
      changedAt: new Date("2026-01-15T00:00:00Z"),
      diff: [],
      source: "test",
    });
    await sub("state@example.com", "state", state);
    await notifyStateSubscribersMonthly(since, until);

    const digestCall = resendSendMock.mock.calls.find((c) => c[0].to === "many@example.com");
    const stateCall = resendSendMock.mock.calls.find((c) => c[0].to === "state@example.com");
    const singleCall = resendSendMock.mock.calls.find((c) => c[0].to === "one@example.com");
    // A multi-watch digest's mailbox unsubscribe means "stop all"; single-target mail stays per-target.
    expect(digestCall![0].headers["List-Unsubscribe"]).toMatch(
      /^<http[^>]*\/api\/subscribe\/unsubscribe\?token=[^&>]+&scope=all>$/
    );
    expect(digestCall![0].text).toContain("Unsubscribe button stops all automated email");
    expect(digestCall![0].html).toContain("Unsubscribe button stops all automated email");
    expect(singleCall![0].headers["List-Unsubscribe"]).not.toContain("scope=all");
    expect(stateCall![0].headers["List-Unsubscribe"]).not.toContain("scope=all");
    for (const call of [digestCall, stateCall, singleCall]) {
      expect(call).toBeDefined();
      expect(call![0].headers["List-Unsubscribe"]).toMatch(/^<.*\/api\/subscribe\/unsubscribe\?token=/);
      expect(call![0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(call![0].html).toContain("Stop all automated email from Compute Atlas");
      expect(call![0].text).toContain("Stop all automated email from Compute Atlas");
    }
  });
});
