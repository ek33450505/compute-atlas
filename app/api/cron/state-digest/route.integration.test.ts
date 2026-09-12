// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client");

// The ONLY send path a state digest can take is sendStateDigestEmail -> resend, so this mock
// is the hard guarantee that no test in this file can put mail on the wire, and its call
// count is the real assertion throughout: a 200 status proves the route ran, only the call
// count proves whether anyone was mailed. Hoisted so the vi.mock factory below can close
// over it.
const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { facilityHistoryTable, subscriptionsTable } from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so lib/notify's transitive imports (lib/db/client, resend)
// resolve against the mocked modules.
import { GET } from "./route";

const CRON_SECRET = "cron-secret-for-tests";
const ADMIN_TOKEN = "admin-token-for-tests";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];

// Three facilities in ONE state, so the window test can seed three history rows that are
// deduped per-facility rather than collapsing into one. Chosen as the state with the most
// records rather than a hardcoded code, so a data wave that retires a facility can't quietly
// turn this fixture into a two-record state.
const byState = new Map<string, Facility[]>();
for (const facility of facilitiesTyped) {
  const list = byState.get(facility.location.state) ?? [];
  list.push(facility);
  byState.set(facility.location.state, list);
}
const [digestState, stateFacilities] = [...byState.entries()].sort(
  (a, b) => b[1].length - a[1].length
)[0];
const [facInWindow, facBeforeWindow, facAfterWindow] = stateFacilities;

// "Now" for the default-window tests: the 1st of the month at 09:00 UTC — exactly when the
// documented cron schedule ("0 9 1 * *") would fire. The default window is therefore
// [2026-08-01T00:00Z, 2026-09-01T00:00Z).
const CRON_FIRE_TIME = new Date("2026-09-01T09:00:00Z");
const IN_WINDOW = new Date("2026-08-15T12:00:00Z"); // inside the previous calendar month
const BEFORE_WINDOW = new Date("2026-07-15T12:00:00Z"); // the month before that
// Earlier TODAY, i.e. after `until` but before `now`. Only the `until` bound excludes this
// one — a `since`-only query sweeps it in, and next month's run would sweep it again.
const AFTER_WINDOW = new Date("2026-09-01T05:00:00Z");

function req(headers?: HeadersInit, query = ""): Request {
  return new Request(`http://localhost/api/cron/state-digest${query}`, {
    method: "GET",
    headers: headers ?? {},
  });
}

const cronAuth = { authorization: `Bearer ${CRON_SECRET}` };
const adminAuth = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function insertHistoryRow(facilityId: string, changedAt: Date): Promise<void> {
  await tdb.db.insert(facilityHistoryTable).values({
    facilityId,
    changeType: "update",
    changedAt,
    diff: [],
    source: "test",
  });
}

async function insertStateSubscription(
  status: "pending" | "confirmed" | "unsubscribed" = "confirmed",
  email = "reader@example.com"
): Promise<void> {
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType: "state",
    targetId: digestState,
    status,
    confirmToken: generateToken(),
    unsubscribeToken: generateToken(),
    confirmedAt: status === "confirmed" ? new Date() : null,
  });
}

/** The happy-path fixture: one confirmed subscriber, one change inside the default window. */
async function seedConfirmedSubscriberWithInWindowChange(): Promise<void> {
  await seedFacility(tdb.db, facInWindow);
  await insertHistoryRow(facInWindow.id, IN_WINDOW);
  await insertStateSubscription("confirmed");
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
  // Only Date is faked — PGlite's async work still needs real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CRON_FIRE_TIME);
  // Explicit per-test env, so a maintainer's real .env.local can never decide an outcome.
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("API_ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("STATE_DIGEST_ENABLED", undefined); // the merged default: OFF
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("GET /api/cron/state-digest — kill switch", () => {
  it("returns 503 and sends nothing when STATE_DIGEST_ENABLED is unset, even with valid cron auth", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("State digest is disabled");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("returns 503 and sends nothing when STATE_DIGEST_ENABLED is any value other than 'true'", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "1");
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(503);
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/state-digest — auth", () => {
  it("returns 401 and sends nothing with no Authorization header", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("returns 401 and sends nothing with a wrong bearer", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req({ authorization: "Bearer not-the-secret" }));

    expect(res.status).toBe(401);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED with 401 when neither CRON_SECRET nor API_ADMIN_TOKEN is configured", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    vi.stubEnv("CRON_SECRET", undefined);
    vi.stubEnv("API_ADMIN_TOKEN", undefined);
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(401);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("checks auth BEFORE the kill switch, so an anonymous caller cannot probe whether the feature is on", async () => {
    // STATE_DIGEST_ENABLED is unset here (the beforeEach default). An unauthenticated caller
    // must get the same 401 they would get if it were on — never a 503 that discloses state.
    const disabledRes = await GET(req());
    expect(disabledRes.status).toBe(401);

    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    const enabledRes = await GET(req());
    expect(enabledRes.status).toBe(401);

    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("accepts the admin bearer as well as the cron secret", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(adminAuth));

    expect(res.status).toBe(200);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/cron/state-digest — who gets mail", () => {
  beforeEach(() => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
  });

  it("sends exactly one digest to one confirmed state subscriber with a matching change", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(200);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0][0].to).toBe("reader@example.com");
    expect(await res.json()).toMatchObject({
      ok: true,
      changes: 1,
      groups: 1,
      recipients: 1,
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-09-01T00:00:00.000Z",
    });
  });

  it("sends ZERO mail to a pending (unconfirmed) state subscriber", async () => {
    // The case that matters most: 3 of the 4 real state rows are pending. Double opt-in is
    // the enforcement boundary, and a 200 here must not mean anyone was mailed.
    await seedFacility(tdb.db, facInWindow);
    await insertHistoryRow(facInWindow.id, IN_WINDOW);
    await insertStateSubscription("pending");

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(200);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, changes: 0, groups: 0, recipients: 0 });
  });

  it("sends ZERO mail to an unsubscribed state subscriber", async () => {
    await seedFacility(tdb.db, facInWindow);
    await insertHistoryRow(facInWindow.id, IN_WINDOW);
    await insertStateSubscription("unsubscribed");

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(200);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("reports counts only — never an email address — in the response body", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth));
    const body = await res.json();

    // Assert the body actually HAS the reporting keys first: a bare
    // `not.toContain` would pass just as happily against `{}`, proving nothing.
    expect(Object.keys(body).sort()).toEqual([
      "changes",
      "groups",
      "ok",
      "recipients",
      "since",
      "until",
    ]);
    expect(body).toMatchObject({ ok: true, changes: 1, groups: 1, recipients: 1 });
    expect(JSON.stringify(body)).not.toContain("reader@example.com");
  });
});

describe("GET /api/cron/state-digest — the calendar window", () => {
  beforeEach(() => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
  });

  it("digests ONLY the previous calendar month — not the month before it, and not today", async () => {
    // ⚠️ This is the test that pins the half-open [since, until) bound. Drop `until` from
    // buildStateDigestChanges and the AFTER_WINDOW row (05:00 today, before the 09:00 fire)
    // is swept in too: changes becomes 2 and the digest names two facilities. Next month's
    // run would then sweep those same hours again, putting one facility in two consecutive
    // digests.
    await seedFacility(tdb.db, facInWindow);
    await seedFacility(tdb.db, facBeforeWindow);
    await seedFacility(tdb.db, facAfterWindow);
    await insertHistoryRow(facInWindow.id, IN_WINDOW);
    await insertHistoryRow(facBeforeWindow.id, BEFORE_WINDOW);
    await insertHistoryRow(facAfterWindow.id, AFTER_WINDOW);
    await insertStateSubscription("confirmed");

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changes: 1, groups: 1, recipients: 1 });
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    // Assert on the rendered list rather than on bare name substrings: two facilities in one
    // state can legitimately share a name prefix, which would make `not.toContain` lie in
    // either direction. Each item line ends with the facility's URL, so an exact suffix match
    // on the single line is prefix-proof.
    const call = resendSendMock.mock.calls[0][0];
    const itemLines = (call.text as string).split("\n").filter((line) => line.startsWith("- "));
    expect(itemLines).toHaveLength(1);
    expect(itemLines[0].endsWith(`/facilities/${facInWindow.id}`)).toBe(true);
    expect(call.subject as string).toContain("1 facility changed");
  });

  it("rolls the window back across a year boundary in January", async () => {
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));

    const res = await GET(req(cronAuth));

    expect(await res.json()).toMatchObject({
      since: "2025-12-01T00:00:00.000Z",
      until: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("GET /api/cron/state-digest — explicit window overrides", () => {
  beforeEach(() => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
  });

  it("honours ?since=&until= on the admin bearer, recovering a month the default window misses", async () => {
    // "Now" is December, so the DEFAULT window (November) contains nothing — only the
    // explicit August override can produce a send, which is what makes this a real test of
    // the override rather than of the default.
    vi.setSystemTime(new Date("2026-12-01T09:00:00Z"));
    await seedConfirmedSubscriberWithInWindowChange();

    const missed = await GET(req(adminAuth));
    expect(await missed.json()).toMatchObject({ changes: 0, groups: 0, recipients: 0 });
    expect(resendSendMock).not.toHaveBeenCalled();

    const recovered = await GET(req(adminAuth, "?since=2026-08-01&until=2026-09-01"));

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      ok: true,
      changes: 1,
      groups: 1,
      recipients: 1,
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-09-01T00:00:00.000Z",
    });
    expect(resendSendMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed date with 400 and sends nothing", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    for (const query of [
      "?since=2026-8-1&until=2026-09-01",
      "?since=not-a-date&until=2026-09-01",
      "?since=2026-08-01T00:00:00Z&until=2026-09-01",
      // Date.parse rolls this over to March 3rd rather than returning NaN; the round-trip
      // check in parseDateOnly is what rejects it.
      "?since=2026-02-31&until=2026-09-01",
    ]) {
      const res = await GET(req(adminAuth, query));
      expect(res.status, query).toBe(400);
    }
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("rejects until <= since with 400 and sends nothing", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    const equal = await GET(req(adminAuth, "?since=2026-08-01&until=2026-08-01"));
    expect(equal.status).toBe(400);

    const inverted = await GET(req(adminAuth, "?since=2026-09-01&until=2026-08-01"));
    expect(inverted.status).toBe(400);

    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("rejects a window longer than 366 days with 400 and sends nothing", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    // The fat-finger case: a recovery run that would mail a real person a digest spanning
    // centuries. Admin-only, so not an attack — one comparison stops it anyway.
    const absurd = await GET(req(adminAuth, "?since=0001-01-01&until=9999-12-31"));
    expect(absurd.status).toBe(400);

    // 367 days — one day over the boundary.
    const justOver = await GET(req(adminAuth, "?since=2025-01-01&until=2026-01-03"));
    expect(justOver.status).toBe(400);

    expect(resendSendMock).not.toHaveBeenCalled();

    // 2024 is a leap year, so this is exactly 366 days — still accepted, proving the cap is
    // a boundary and not an off-by-one that rejects a legitimate leap-year recovery.
    const atLimit = await GET(req(adminAuth, "?since=2024-01-01&until=2025-01-01"));
    expect(atLimit.status).toBe(200);
  });

  it("rejects a half-given window with 400", async () => {
    const res = await GET(req(adminAuth, "?since=2026-08-01"));
    expect(res.status).toBe(400);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("refuses overrides on the cron-secret path — they are admin-only, never silently ignored", async () => {
    await seedConfirmedSubscriberWithInWindowChange();

    const res = await GET(req(cronAuth, "?since=2020-01-01&until=2026-09-01"));

    expect(res.status).toBe(400);
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/state-digest — failure reporting", () => {
  it("returns 500 when the notifier reports a failed run, so it cannot pass for a quiet month", async () => {
    vi.stubEnv("STATE_DIGEST_ENABLED", "true");
    vi.mocked(dbClient.getDb).mockImplementationOnce(() => {
      throw new Error("db unreachable");
    });

    const res = await GET(req(cronAuth));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, changes: 0, groups: 0, recipients: 0 });
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});
