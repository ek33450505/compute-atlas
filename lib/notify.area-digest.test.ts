// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client");

const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { emailSendsTable, facilityHistoryTable, stateDigestRunsTable, subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendAreaDigestEmail } from "@/lib/email";
import { suppress } from "@/lib/suppressions";
import { countySlug } from "@/lib/counties";
import { notifyStateSubscribersMonthly } from "@/lib/notify";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

const base = (facilitiesRaw as unknown as Facility[])[0];

function mk(id: string, name: string, state: string, county: string | undefined): Facility {
  return { ...base, id, name, location: { ...base.location, state, county } };
}

const loudoun = mk("t-loudoun-va", "Loudoun Campus", "VA", "Loudoun County");
const fairfax = mk("t-fairfax-va", "Fairfax Campus", "VA", "Fairfax");
const hudsonNj = mk("t-hudson-nj", "Hudson Campus", "NJ", "Hudson");
const bergenNj = mk("t-bergen-nj", "Bergen Campus", "NJ", "Bergen");
const noCountyVa = mk("t-nocounty-va", "Nowhere Campus", "VA", undefined);
const stlCity = mk("t-stl-mo", "St Louis Campus", "MO", "St. Louis city");

const since = new Date("2026-01-01T00:00:00Z");
const until = new Date("2026-02-01T00:00:00Z");
const within = new Date("2026-01-15T00:00:00Z");

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
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

async function changed(f: Facility, changeType: "create" | "update" | "editorial" = "update") {
  await seedFacility(tdb.db, f);
  await tdb.db.insert(facilityHistoryTable).values({
    facilityId: f.id,
    changeType,
    changedAt: within,
    diff: [],
    source: "test",
  });
}

async function sub(
  email: string,
  targetType: "state" | "county" | "metro",
  targetId: string,
  status: "confirmed" | "unsubscribed" = "confirmed"
) {
  const unsubscribeToken = generateToken();
  const [row] = await tdb.db
    .insert(subscriptionsTable)
    .values({ email, targetType, targetId, status, confirmToken: generateToken(), unsubscribeToken })
    .returning();
  return { id: row.id, unsubscribeToken };
}

const sentMail = () => resendSendMock.mock.calls.map((c) => c[0]);

describe("area digest — county and metro (A-3 unit 8b, D9)", () => {
  it("a county sub gets one area_digest email listing only that county's facilities, with county copy and the run id", async () => {
    await changed(loudoun);
    await changed(fairfax);
    await changed(hudsonNj);
    const s = await sub("c@example.com", "county", countySlug("Loudoun County", "VA"));

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toEqual({ ok: true, changes: 1, groups: 1, recipients: 1 });
    const [mail] = sentMail();
    expect(sentMail()).toHaveLength(1);
    expect(mail.to).toBe("c@example.com");
    expect(mail.subject).toBe("1 facility changed in Loudoun County, VA — Compute Atlas monthly digest");
    expect(mail.text).toContain("Your monthly Compute Atlas digest for Loudoun County, VA");
    expect(mail.text).toContain("Unsubscribe from this county's digest");
    expect(mail.html).toContain("Unsubscribe from this county's digest");
    expect(mail.text).toContain(loudoun.name);
    expect(mail.text).not.toContain(fairfax.name);
    expect(mail.text).not.toContain(hudsonNj.name);
    expect(mail.text).toContain(`token=${encodeURIComponent(s.unsubscribeToken)}&scope=all`);
    expect(mail.headers["List-Unsubscribe"]).toContain(encodeURIComponent(s.unsubscribeToken));

    const [send] = await tdb.db.select().from(emailSendsTable);
    const [run] = await tdb.db.select().from(stateDigestRunsTable);
    expect(send.kind).toBe("area_digest");
    expect(send.runId).toBe(run.id);
  });

  it("a metro sub spanning two states (new-york-city) gets one email including the NJ facility, with metro copy", async () => {
    await changed(hudsonNj);
    await changed(bergenNj); // NJ, but not in the metro's county set
    await sub("m@example.com", "metro", "new-york-city");

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toMatchObject({ changes: 1, groups: 1, recipients: 1 });
    const [mail] = sentMail();
    expect(mail.subject).toBe("1 facility changed in New York City Metro — Compute Atlas monthly digest");
    expect(mail.text).toContain("Your monthly Compute Atlas digest for New York City Metro");
    expect(mail.text).toContain("Unsubscribe from this metro area's digest");
    expect(mail.text).toContain(hudsonNj.name);
    expect(mail.text).not.toContain(bergenNj.name);
    const [send] = await tdb.db.select().from(emailSendsTable);
    expect(send.kind).toBe("area_digest");
  });

  it("a metro sub does not list a record with no county", async () => {
    await changed(noCountyVa);
    await changed(loudoun);
    await sub("m@example.com", "metro", "northern-virginia");
    await notifyStateSubscribersMonthly(since, until);
    const [mail] = sentMail();
    expect(mail.text).toContain(loudoun.name);
    expect(mail.text).not.toContain(noCountyVa.name);
  });

  it("one person with a state sub and a county sub in it gets two separate, labelled emails (D5)", async () => {
    await changed(loudoun);
    await sub("both@example.com", "state", "VA");
    await sub("both@example.com", "county", countySlug("Loudoun County", "VA"));

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toMatchObject({ groups: 2, recipients: 2 });
    const mails = sentMail();
    expect(mails).toHaveLength(2);
    const stateMail = mails.find((m) => m.text.includes("digest for Virginia:"))!;
    const countyMail = mails.find((m) => m.text.includes("digest for Loudoun County, VA:"))!;
    expect(stateMail.text).toContain("Unsubscribe from this state's digest");
    expect(countyMail.text).toContain("Unsubscribe from this county's digest");
    const kinds = (await tdb.db.select().from(emailSendsTable)).map((r) => r.kind).sort();
    expect(kinds).toEqual(["area_digest", "state_digest"]);
  });

  it("a suppressed county sub and an unsubscribed metro sub get no mail", async () => {
    await changed(loudoun);
    await sub("out@example.com", "county", countySlug("Loudoun County", "VA"));
    await suppress(
      tdb.db,
      "out@example.com",
      { kind: "target", targetType: "county", targetId: countySlug("Loudoun County", "VA") },
      "unsubscribe"
    );
    await sub("gone@example.com", "metro", "northern-virginia", "unsubscribed");

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(resendSendMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, recipients: 0 });
  });

  it("an editorial-only history row is not listed", async () => {
    await changed(loudoun, "editorial");
    await sub("c@example.com", "county", countySlug("Loudoun County", "VA"));
    await notifyStateSubscribersMonthly(since, until);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("two states' same-name counties: each subscriber gets only their own state's changes", async () => {
    const washVa = mk("t-wash-va", "Washington VA Campus", "VA", "Washington County");
    const washNj = mk("t-wash-nj", "Washington NJ Campus", "NJ", "Washington County");
    await changed(washVa);
    await changed(washNj);
    // Both states are in the prefilter, so only `matches` can tell them apart.
    await sub("w-va@example.com", "county", countySlug("Washington County", "VA"));
    await sub("w-nj@example.com", "county", countySlug("Washington County", "NJ"));

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toMatchObject({ changes: 2, groups: 2, recipients: 2 });
    const va = sentMail().find((m) => m.to === "w-va@example.com")!;
    const nj = sentMail().find((m) => m.to === "w-nj@example.com")!;
    expect(va.text).toContain(washVa.name);
    expect(va.text).not.toContain(washNj.name);
    expect(nj.text).toContain(washNj.name);
    expect(nj.text).not.toContain(washVa.name);
  });

  it("warns once, naming the unknown metro slug and no address, when a metro slug no longer resolves", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await changed(loudoun);
    await sub("gone-metro@example.com", "metro", "no-such-metro");
    await sub("gone-metro2@example.com", "metro", "no-such-metro");

    await notifyStateSubscribersMonthly(since, until);

    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("area digest:"));
    expect(lines).toEqual(["area digest: skipped 2 subscription(s) for unknown metro(s): no-such-metro"]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("@example.com");
  });

  it("strips control characters from the area name in the subject and text", async () => {
    await sendAreaDigestEmail(
      "x@example.com",
      { type: "county", name: "Evil\r\nBcc: a@b.c County, VA" },
      [
        {
          unsubscribeToken: "tok",
          facilityName: "F",
          facilitySlug: "f",
          changeLabel: "record updated",
          status: "Operational",
        },
      ] as never
    );
    const [mail] = sentMail();
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toContain("Evil Bcc: a@b.c County, VA");
    expect(mail.text).toContain("digest for Evil Bcc: a@b.c County, VA:");
  });

  it("keeps a non-ASCII county name byte for byte through the control-char strip", async () => {
    await sendAreaDigestEmail(
      "x@example.com",
      { type: "county", name: "Doña Ana County, NM" },
      [
        {
          unsubscribeToken: "tok",
          facilityName: "F",
          facilitySlug: "f",
          changeLabel: "record updated",
          status: "Operational",
        },
      ] as never
    );
    const [mail] = sentMail();
    expect(mail.subject).toBe("1 facility changed in Doña Ana County, NM — Compute Atlas monthly digest");
    expect(mail.text).toContain("digest for Doña Ana County, NM:");
  });

  it("kill switch WATCH_AREAS_ENABLED=false skips county and metro but still sends state", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("WATCH_AREAS_ENABLED", "false");
    await changed(loudoun);
    await sub("s@example.com", "state", "VA");
    await sub("c@example.com", "county", countySlug("Loudoun County", "VA"));
    await sub("m@example.com", "metro", "northern-virginia");

    const result = await notifyStateSubscribersMonthly(since, until);

    expect(result).toMatchObject({ changes: 1, groups: 1, recipients: 1 });
    expect(sentMail().map((m) => m.to)).toEqual(["s@example.com"]);
    expect(info).toHaveBeenCalledWith(
      "area digest: WATCH_AREAS_ENABLED=false; county and metro subscriptions not read this run"
    );
  });

  it("a repeat call for the same window sends nothing", async () => {
    await changed(loudoun);
    await sub("c@example.com", "county", countySlug("Loudoun County", "VA"));
    await notifyStateSubscribersMonthly(since, until);
    const second = await notifyStateSubscribersMonthly(since, until);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(second.alreadyRun).toBeDefined();
    expect(second.recipients).toBe(0);
  });

  it('resolves the "St. Louis city" county slug edge and labels it without a doubled County', async () => {
    await changed(stlCity);
    await sub("c@example.com", "county", countySlug("St. Louis city", "MO"));
    await notifyStateSubscribersMonthly(since, until);
    const [mail] = sentMail();
    expect(mail.subject).toBe("1 facility changed in St. Louis city, MO — Compute Atlas monthly digest");
    expect(mail.text).toContain(stlCity.name);
  });
});

describe("sendAreaDigestEmail — state copy is byte-identical to the pre-8b sender", () => {
  it("pins the exact subject, text, html and headers for a fixed state input", async () => {
    await sendAreaDigestEmail(
      "x@example.com",
      { type: "state", name: "Texas" },
      [
        {
          facilityName: "Alpha <Site>",
          facilitySlug: "alpha",
          changeLabel: "record updated",
          status: "Operational",
          unsubscribeToken: "tok en",
        },
      ]
    );
    const unsub = "https://example.test/api/subscribe/unsubscribe?token=tok%20en";
    const stopAll = `${unsub}&scope=all`;
    const [mail] = sentMail();
    expect(mail.to).toBe("x@example.com");
    expect(mail.subject).toBe("1 facility changed in Texas — Compute Atlas monthly digest");
    expect(mail.text).toBe(
      `Your monthly Compute Atlas digest for Texas: 1 tracked facility changed this period.\n\n- Alpha <Site> — record updated (now Operational): https://example.test/facilities/alpha\n\nYou're receiving this because you subscribed to a monthly digest for Texas on Compute Atlas. Unsubscribe from this state's digest: ${unsub}\nStop all automated email from Compute Atlas: ${stopAll}`
    );
    expect(mail.html).toBe(
      `<p>Your monthly Compute Atlas digest for <strong>Texas</strong>: 1 tracked facility changed this period.</p><ul><li><strong>Alpha &lt;Site&gt;</strong> — record updated (now Operational). <a href="https://example.test/facilities/alpha">View it</a></li></ul><p style="color:#666;font-size:0.85em;">You're receiving this because you subscribed to a monthly digest for Texas on Compute Atlas. <a href="${unsub}">Unsubscribe from this state's digest</a> · <a href="${stopAll.replace("&", "&amp;")}">Stop all automated email from Compute Atlas</a></p>`
    );
    expect(mail.headers).toEqual({
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});
