// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import {
  createLead,
  listLeadsForAdmin,
  updateLeadStatus,
  promoteLead,
  resetLeadToNew,
  stageLeadSubmission,
} from "@/lib/leads";
import { submissionsTable, leadsTable } from "@/lib/db/schema";
import type { Facility } from "@/lib/schema";
import { eq } from "drizzle-orm";

let tdb: TestDbHandle;

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

describe("createLead", () => {
  it("inserts a valid lead and returns an id", async () => {
    const result = await createLead(
      { url: "https://example.com/tip", note: "possible new site" },
      "hash-1"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBeTruthy();

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/tip");
    expect(rows[0].status).toBe("new");
  });

  // Security-relevant: a javascript: URL must be rejected, not stored.
  it("rejects a javascript: URL", async () => {
    const result = await createLead({ url: "javascript:alert(1)" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(0);
  });

  it("rejects a URL over 2000 characters", async () => {
    const longUrl = "https://example.com/" + "a".repeat(2000);
    const result = await createLead({ url: longUrl }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects a note over 500 characters", async () => {
    const longNote = "a".repeat(501);
    const result = await createLead({ url: "https://example.com/tip", note: longNote }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(0);
  });

  it("rejects a missing url", async () => {
    const result = await createLead({ note: "no url here" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("drops an email-like attribution rather than storing it", async () => {
    const result = await createLead(
      { url: "https://example.com/tip", attribution: "someone@example.com" },
      "hash-1"
    );
    expect(result.ok).toBe(true);

    const rows = await listLeadsForAdmin();
    expect(rows[0].attribution).toBeNull();
  });
});

describe("listLeadsForAdmin", () => {
  it("ignores an unrecognized status filter instead of returning nothing", async () => {
    await createLead({ url: "https://example.com/a" }, "hash-1");
    await createLead({ url: "https://example.com/b" }, "hash-1");

    const rows = await listLeadsForAdmin("not-a-real-status");
    expect(rows).toHaveLength(2);
  });

  // Security-relevant: app/admin/leads/page.tsx passes these rows straight
  // into a "use client" component, and EVERY field on a row crosses into the
  // browser in the RSC payload whether or not it's rendered in JSX. This
  // asserts the exact key set rather than merely "no submitterIpHash" so it
  // also fails if any OTHER un-vetted column (present or future) starts
  // crossing the boundary — the actual invariant is "only these columns
  // leave the server," not "this one specific field stays behind."
  it("returns only the columns the admin UI needs, never submitterIpHash", async () => {
    await createLead({ url: "https://example.com/a", note: "n", attribution: "A" }, "hash-1");

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "id",
        "createdAt",
        "url",
        "note",
        "attribution",
        "status",
        "triage",
        "reviewNote",
        "reviewedAt",
        "promotedSubmissionId",
      ].sort()
    );
    expect(rows[0]).not.toHaveProperty("submitterIpHash");
  });
});

describe("updateLeadStatus", () => {
  it("rejects an unknown status", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const result = await updateLeadStatus(created.id, "bogus-status");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("409s on a repeat transition to the same status", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const first = await updateLeadStatus(created.id, "researching");
    expect(first.ok).toBe(true);

    const repeat = await updateLeadStatus(created.id, "researching");
    expect(repeat.ok).toBe(false);
    if (repeat.ok) return;
    expect(repeat.status).toBe(409);
  });
});

describe("promoteLead", () => {
  it("sets status=promoted and records promotedSubmissionId in one write", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const result = await promoteLead(created.id, "11111111-1111-1111-1111-111111111111", "auto-staged");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.status).toBe("promoted");
    expect(result.lead.promotedSubmissionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.lead.reviewNote).toBe("auto-staged");
    expect(result.lead.reviewedAt).not.toBeNull();

    const rows = await listLeadsForAdmin("promoted");
    expect(rows).toHaveLength(1);
    expect(rows[0].promotedSubmissionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("404s on an unknown lead id", async () => {
    const result = await promoteLead(
      "00000000-0000-0000-0000-000000000000",
      "22222222-2222-2222-2222-222222222222"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("409s when the lead is already promoted", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const first = await promoteLead(created.id, "33333333-3333-3333-3333-333333333333");
    expect(first.ok).toBe(true);

    const repeat = await promoteLead(created.id, "44444444-4444-4444-4444-444444444444");
    expect(repeat.ok).toBe(false);
    if (repeat.ok) return;
    expect(repeat.status).toBe(409);
  });
});

describe("resetLeadToNew", () => {
  // Defect 1: promoteLead is promotedSubmissionId's only writer, so a non-null
  // id means a real staged submission exists. Re-queueing the lead with the id
  // still set lets the discovery lane stage a SECOND submission for the site.
  it("clears a non-null promotedSubmissionId when it re-queues the lead", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const promoted = await promoteLead(created.id, "55555555-5555-5555-5555-555555555555");
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.lead.promotedSubmissionId).toBe("55555555-5555-5555-5555-555555555555");

    const result = await resetLeadToNew(created.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.status).toBe("new");
    expect(result.lead.promotedSubmissionId).toBeNull();
    expect(result.lead.reviewedAt).not.toBeNull();

    // Read back: the row the lane would queue must carry no submission id.
    const rows = await listLeadsForAdmin("new");
    expect(rows).toHaveLength(1);
    expect(rows[0].promotedSubmissionId).toBeNull();
  });

  // Defect 2: the UI calls this with no note, and updateLeadStatus would write
  // `reviewNote ?? null` — silently destroying the recorded dismissal reason.
  it("preserves the prior reviewNote verbatim when called with no note", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const dismissed = await updateLeadStatus(created.id, "dismissed", "duplicate of an existing site");
    expect(dismissed.ok).toBe(true);

    const result = await resetLeadToNew(created.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.status).toBe("new");
    expect(result.lead.reviewNote).toBe("duplicate of an existing site");
  });

  it("retains the prior reviewNote alongside a new one", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const dismissed = await updateLeadStatus(created.id, "dismissed", "duplicate of an existing site");
    expect(dismissed.ok).toBe(true);

    const result = await resetLeadToNew(created.id, "dismissed in error, re-opening");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.reviewNote).toBe(
      "dismissed in error, re-opening\n\n(previous note: duplicate of an existing site)"
    );
  });

  // An empty or whitespace-only note is NOT a new note: `reviewNote && …` treated
  // "" as falsy and fell through to `"" ?? row.reviewNote` → "", wiping the
  // dismissal reason. Reachable by a direct Server Action call (the UI passes no arg).
  it("preserves the prior reviewNote when called with an empty-string note", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const dismissed = await updateLeadStatus(created.id, "dismissed", "duplicate of an existing site");
    expect(dismissed.ok).toBe(true);

    const result = await resetLeadToNew(created.id, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.status).toBe("new");
    expect(result.lead.reviewNote).toBe("duplicate of an existing site");
  });

  it("preserves the prior reviewNote when called with a whitespace-only note", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const dismissed = await updateLeadStatus(created.id, "dismissed", "duplicate of an existing site");
    expect(dismissed.ok).toBe(true);

    const result = await resetLeadToNew(created.id, "   ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.reviewNote).toBe("duplicate of an existing site");
  });

  it("409s when the lead is already new", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const result = await resetLeadToNew(created.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe("Lead already new");
  });

  it("404s on an unknown lead id", async () => {
    const result = await resetLeadToNew("00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("stageLeadSubmission", () => {
  function makeDoc(id: string): Facility {
    return {
      id,
      name: "Stage Test Facility",
      operator: "Test Operator",
      facilityType: "data_center",
      status: "proposed",
      confidence: "rumored",
      statusHistory: [],
      location: { lat: 33.4, lon: -84.4, state: "GA", precision: "approximate" },
      sources: [{ url: "https://example.com/s0", label: "s0", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
    };
  }

  async function makeLead(note?: string, attribution?: string): Promise<string> {
    const created = await createLead({ url: "https://example.com/tip", note, attribution }, "hash-1");
    if (!created.ok) throw new Error("setup failed");
    return created.id;
  }

  async function getLead(id: string) {
    const [row] = await tdb.db.select().from(leadsTable).where(eq(leadsTable.id, id));
    return row;
  }

  async function getSubmission(id: string) {
    const [row] = await tdb.db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
    return row;
  }

  it("stages a pending create submission and promotes the lead", async () => {
    const leadId = await makeLead("a note", "A Local");

    const result = await stageLeadSubmission(leadId, {
      kind: "create",
      payload: makeDoc("new-site"),
      extraSources: ["https://example.com/extra", "https://example.com/tip"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leadPromoted).toBe(true);

    const sub = await getSubmission(result.submissionId);
    expect(sub.status).toBe("pending");
    expect(sub.kind).toBe("create");
    const prov = sub.provenance as Record<string, unknown>;
    expect(prov.discoveredBy).toBe(`lead:${leadId}`);
    expect(prov.sources).toEqual(["https://example.com/tip", "https://example.com/extra"]);
    expect(prov.note).toBe("a note");
    expect(prov.attribution).toBe("A Local");

    const lead = await getLead(leadId);
    expect(lead.status).toBe("promoted");
    expect(lead.promotedSubmissionId).toBe(result.submissionId);
  });

  it("stages an update submission against an existing facility", async () => {
    await seedFacility(tdb.db, makeDoc("existing-site"));
    const leadId = await makeLead();

    const result = await stageLeadSubmission(leadId, {
      kind: "update",
      targetFacilityId: "existing-site",
      payload: { status: "operational" },
      note: "  confirmed open  ",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sub = await getSubmission(result.submissionId);
    expect(sub.kind).toBe("update");
    expect(sub.targetFacilityId).toBe("existing-site");
    expect(sub.payload).toEqual({ status: "operational" });
    expect((sub.provenance as Record<string, unknown>).note).toBe("confirmed open");
  });

  it("lets an already-promoted lead stage another submission without changing its link", async () => {
    const leadId = await makeLead();
    const first = await stageLeadSubmission(leadId, { kind: "create", payload: makeDoc("site-one") });
    if (!first.ok) throw new Error("setup failed");

    const second = await stageLeadSubmission(leadId, { kind: "create", payload: makeDoc("site-two") });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.leadPromoted).toBe(false);
    expect(second.submissionId).not.toBe(first.submissionId);
    expect((await getLead(leadId)).promotedSubmissionId).toBe(first.submissionId);
  });

  it("409s for a dismissed lead and stages nothing", async () => {
    const leadId = await makeLead();
    await updateLeadStatus(leadId, "dismissed", "spam");

    const result = await stageLeadSubmission(leadId, { kind: "create", payload: makeDoc("x-site") });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
  });

  it("404s for an unknown lead", async () => {
    const result = await stageLeadSubmission("00000000-0000-0000-0000-000000000000", {
      kind: "create",
      payload: makeDoc("x-site"),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("409s when a create payload's id already exists", async () => {
    await seedFacility(tdb.db, makeDoc("taken"));
    const leadId = await makeLead();

    const result = await stageLeadSubmission(leadId, { kind: "create", payload: makeDoc("taken") });

    expect(result).toMatchObject({ ok: false, status: 409 });
    if (result.ok) return;
    expect(result.error).toContain("already exists");
    expect((await getLead(leadId)).status).toBe("new");
  });

  it("400s with issues for an invalid create payload", async () => {
    const leadId = await makeLead();

    const result = await stageLeadSubmission(leadId, { kind: "create", payload: { id: "bad" } });

    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid facility" });
    if (result.ok) return;
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("400s for a non-object or array payload", async () => {
    const leadId = await makeLead();
    expect(await stageLeadSubmission(leadId, { kind: "create", payload: [] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await stageLeadSubmission(leadId, { kind: "create", payload: "x" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("400s when the merged update doc fails facilitySchema", async () => {
    await seedFacility(tdb.db, makeDoc("existing-site"));
    const leadId = await makeLead();

    const result = await stageLeadSubmission(leadId, {
      kind: "update",
      targetFacilityId: "existing-site",
      payload: { status: "not-a-status" },
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
  });

  it("400s an update without a target and 404s an unknown target", async () => {
    const leadId = await makeLead();
    expect(await stageLeadSubmission(leadId, { kind: "update", payload: {} })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await stageLeadSubmission(leadId, { kind: "update", targetFacilityId: "nope", payload: {} })
    ).toMatchObject({ ok: false, status: 404, error: "Facility not found" });
  });

  it("400s on a bad extra source URL and stages nothing", async () => {
    const leadId = await makeLead();

    const result = await stageLeadSubmission(leadId, {
      kind: "create",
      payload: makeDoc("new-site"),
      extraSources: ["javascript:alert(1)"],
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
  });
});

describe("promoteLead — conditional write", () => {
  it("never overwrites an already-promoted lead's submission id", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "h");
    if (!created.ok) throw new Error("setup failed");
    await promoteLead(created.id, "11111111-1111-1111-1111-111111111111");

    const again = await promoteLead(created.id, "22222222-2222-2222-2222-222222222222");

    expect(again).toMatchObject({ ok: false, status: 409 });
    const [row] = await tdb.db.select().from(leadsTable).where(eq(leadsTable.id, created.id));
    expect(row.promotedSubmissionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("the conditional UPDATE alone stops a promote that read a stale 'new' row", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "h");
    if (!created.ok) throw new Error("setup failed");
    const A = "11111111-1111-1111-1111-111111111111";
    await promoteLead(created.id, A);
    const [real] = await tdb.db.select().from(leadsTable).where(eq(leadsTable.id, created.id));

    // Force the race: promoteLead's read sees the lead as still `new`, while
    // the row is already promoted. Writes go to the real db.
    const staleDb = {
      select: () => ({ from: () => ({ where: async () => [{ ...real, status: "new" }] }) }),
      update: (...args: Parameters<typeof tdb.db.update>) => tdb.db.update(...args),
    };
    vi.mocked(dbClient.getDb).mockReturnValueOnce(staleDb as never);

    const result = await promoteLead(created.id, "22222222-2222-2222-2222-222222222222");

    expect(result).toMatchObject({ ok: false, status: 409 });
    const [row] = await tdb.db.select().from(leadsTable).where(eq(leadsTable.id, created.id));
    expect(row.status).toBe("promoted");
    expect(row.promotedSubmissionId).toBe(A);
  });

  it("does not resurrect a dismissed lead", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "h");
    if (!created.ok) throw new Error("setup failed");
    await updateLeadStatus(created.id, "dismissed", "spam");

    // The race: the row is read as non-promoted, then dismissed before the write.
    // Simulated at the DB layer, so only the conditional WHERE can stop it.
    const result = await promoteLead(created.id, "11111111-1111-1111-1111-111111111111");

    expect(result).toMatchObject({ ok: false, status: 409 });
    const [row] = await tdb.db.select().from(leadsTable).where(eq(leadsTable.id, created.id));
    expect(row.status).toBe("dismissed");
    expect(row.promotedSubmissionId).toBeNull();
  });
});

describe("stageLeadSubmission — hardening", () => {
  function doc(id: string): Facility {
    return {
      id,
      name: "Hardening Facility",
      operator: "Op",
      facilityType: "data_center",
      status: "proposed",
      confidence: "rumored",
      statusHistory: [],
      location: { lat: 33.4, lon: -84.4, state: "GA", precision: "approximate" },
      sources: [{ url: "https://example.com/s0", label: "s0", retrievedAt: "2026-01-01", kind: "press" }],
      lastUpdated: "2026-01-01",
    };
  }

  async function insertLead(attribution: string | null): Promise<string> {
    const [row] = await tdb.db
      .insert(leadsTable)
      .values({ url: "https://example.com/tip", attribution, submitterIpHash: "h" })
      .returning({ id: leadsTable.id });
    return row.id;
  }

  async function stagedProvenance(leadId: string, id: string): Promise<Record<string, unknown>> {
    const result = await stageLeadSubmission(leadId, { kind: "create", payload: doc(id) });
    if (!result.ok) throw new Error(`stage failed: ${result.error}`);
    const [sub] = await tdb.db.select().from(submissionsTable).where(eq(submissionsTable.id, result.submissionId));
    return sub.provenance as Record<string, unknown>;
  }

  it("re-sanitizes a stored attribution", async () => {
    const prov = await stagedProvenance(await insertLead("@Foo!"), "attr-site");
    expect(prov.attribution).toBe("Foo");
  });

  it("omits an email-like attribution entirely", async () => {
    const prov = await stagedProvenance(await insertLead("me@example.com"), "email-site");
    expect(prov).not.toHaveProperty("attribution");
  });

  it("409s a create whose id is already proposed by a pending submission", async () => {
    const first = await stageLeadSubmission(await insertLead(null), { kind: "create", payload: doc("dup-site") });
    expect(first.ok).toBe(true);

    const other = await insertLead(null);
    const second = await stageLeadSubmission(other, { kind: "create", payload: doc("dup-site") });

    expect(second).toMatchObject({ ok: false, status: 409 });
    if (second.ok) return;
    expect(second.error).toBe("A pending submission already proposes dup-site");
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(1);
  });

  it("404s a non-uuid lead id without querying, and 400s a null input", async () => {
    expect(await stageLeadSubmission("not-a-uuid", { kind: "create", payload: {} })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(
      await stageLeadSubmission(await insertLead(null), null as unknown as Parameters<typeof stageLeadSubmission>[1])
    ).toMatchObject({ ok: false, status: 400 });
  });
});
