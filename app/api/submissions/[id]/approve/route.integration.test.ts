// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// Only the outbound send is mocked — a watcher email is observable as a
// sendChangeNotification call, with no network and no Resend key needed.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendChangeNotification: vi.fn().mockResolvedValue({ sent: true }) };
});

// A call-through spy: the real approveSubmission still runs, but a test can
// assert it was (or, for a gated 409, was NOT) reached.
vi.mock("@/lib/submissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/submissions")>();
  return { ...actual, approveSubmission: vi.fn(actual.approveSubmission) };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import {
  facilitiesTable,
  facilityHistoryTable,
  submissionsTable,
  subscriptionsTable,
} from "@/lib/db/schema";
import { generateToken, sendChangeNotification } from "@/lib/email";
import { approveSubmission } from "@/lib/submissions";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/submissions.ts -> lib/facility-write.ts -> lib/db/client.ts) resolve
// against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn, status: operational

function req(): Request {
  return new Request("http://localhost/api/submissions/x/approve", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

let tdb: TestDbHandle;

beforeAll(async () => {
  process.env.API_ADMIN_TOKEN = "test-token";
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

async function insertSubmission(values: {
  kind: "create" | "update";
  targetFacilityId?: string;
  payload: Record<string, unknown>;
  status?: string;
}): Promise<string> {
  const [row] = await tdb.db
    .insert(submissionsTable)
    .values({
      kind: values.kind,
      targetFacilityId: values.targetFacilityId,
      payload: values.payload,
      provenance: { sources: ["https://example.com/x"], discoveredBy: "test" },
      status: values.status ?? "pending",
    })
    .returning({ id: submissionsTable.id });
  return row.id;
}

describe("POST /api/submissions/[id]/approve (authorized happy path)", () => {
  it("promotes a create submission to a live facility and records facility_history", async () => {
    const id = await insertSubmission({ kind: "create", payload: seedDoc });

    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows).toHaveLength(1);

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("create");
    expect(historyRows[0].source).toBe(id);

    const submissionRows = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));
    expect(submissionRows[0].status).toBe("approved");
  });

  it("promotes an update submission's patch onto an existing facility and records the update in facility_history", async () => {
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
    });

    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);

    const facilityRows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    expect(facilityRows[0].doc.status).toBe("under_construction");

    const historyRows = await tdb.db
      .select()
      .from(facilityHistoryTable)
      .where(eq(facilityHistoryTable.facilityId, seedDoc.id));
    expect(historyRows).toHaveLength(1);
    expect(historyRows[0].changeType).toBe("update");
    expect(historyRows[0].source).toBe(id);
  });

  it("404s approving a non-existent submission id", async () => {
    const res = await POST(req(), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("409s approving an already-approved submission", async () => {
    const id = await insertSubmission({ kind: "create", payload: seedDoc, status: "approved" });
    const res = await POST(req(), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/submissions/[id]/approve (watcher gate)", () => {
  function reqWithBody(body: string): Request {
    return new Request("http://localhost/api/submissions/x/approve", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body,
    });
  }

  async function insertWatcher(status: "pending" | "confirmed" | "unsubscribed") {
    await tdb.db.insert(subscriptionsTable).values({
      email: `${generateToken().slice(0, 12)}@example.com`,
      targetType: "facility",
      targetId: seedDoc.id,
      status,
      confirmToken: generateToken(),
      unsubscribeToken: generateToken(),
    });
  }

  async function watchedUpdate(): Promise<string> {
    await seedFacility(tdb.db, seedDoc);
    await insertWatcher("confirmed");
    return insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
    });
  }

  async function submissionStatus(id: string): Promise<string> {
    const rows = await tdb.db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
    return rows[0].status;
  }

  async function facilityStatus(): Promise<string> {
    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    return rows[0].doc.status;
  }

  it.each([
    ["no body", undefined],
    ["a body with only a reviewNote", JSON.stringify({ reviewNote: "checked" })],
    ["notifyWatchers: false", JSON.stringify({ notifyWatchers: false })],
    ["a truthy non-boolean notifyWatchers", JSON.stringify({ notifyWatchers: "true" })],
    ["a malformed body", "{not json"],
  ])("409s a row with a confirmed watcher and approves nothing — %s", async (_name, body) => {
    const id = await watchedUpdate();

    const res = await POST(body === undefined ? req() : reqWithBody(body), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "approval would email confirmed watchers",
      watcherCount: 1,
    });
    expect(approveSubmission).not.toHaveBeenCalled();
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(await submissionStatus(id)).toBe("pending");
    expect(await facilityStatus()).toBe(seedDoc.status);
  });

  it("approves and emails the watcher when the body carries notifyWatchers: true, passing the reviewNote through", async () => {
    const id = await watchedUpdate();

    const res = await POST(reqWithBody(JSON.stringify({ reviewNote: "ok", notifyWatchers: true })), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect(approveSubmission).toHaveBeenCalledWith(id, "ok");
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(await submissionStatus(id)).toBe("approved");
    expect(await facilityStatus()).toBe("under_construction");
  });

  it("approves a row with no confirmed watcher without any flag (pending and unsubscribed rows do not count)", async () => {
    await seedFacility(tdb.db, seedDoc);
    await insertWatcher("pending");
    await insertWatcher("unsubscribed");
    const id = await insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
    });

    const res = await POST(reqWithBody(JSON.stringify({ reviewNote: "ok" })), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect(approveSubmission).toHaveBeenCalledWith(id, "ok");
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(await submissionStatus(id)).toBe("approved");
  });

  it("approves a 0-watcher row when the body is malformed, as before", async () => {
    await seedFacility(tdb.db, seedDoc);
    const id = await insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
    });

    const res = await POST(reqWithBody("{not json"), { params: Promise.resolve({ id }) });

    expect(res.status).toBe(200);
    expect(await submissionStatus(id)).toBe("approved");
  });

  it("reports the already-approved 409, not the watcher 409, for a reviewed row whose target has watchers", async () => {
    await seedFacility(tdb.db, seedDoc);
    await insertWatcher("confirmed");
    const id = await insertSubmission({
      kind: "update",
      targetFacilityId: seedDoc.id,
      payload: { status: "under_construction" },
      status: "approved",
    });

    const res = await POST(req(), { params: Promise.resolve({ id }) });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Submission already approved");
    expect(body.watcherCount).toBeUndefined();
  });

  async function facilityRowCount(): Promise<number> {
    const rows = await tdb.db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, seedDoc.id));
    return rows.length;
  }

  it("409s a create that reuses a slug with surviving confirmed watchers, before any facility row exists", async () => {
    await insertWatcher("confirmed"); // watches seedDoc.id, which has NO facility row
    const id = await insertSubmission({ kind: "create", payload: seedDoc });

    const res = await POST(req(), { params: Promise.resolve({ id }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "approval would email confirmed watchers",
      watcherCount: 1,
    });
    expect(approveSubmission).not.toHaveBeenCalled();
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(await submissionStatus(id)).toBe("pending");
    expect(await facilityRowCount()).toBe(0);
  });

  it("approves that create, and mails the surviving watcher, once the body carries notifyWatchers: true", async () => {
    await insertWatcher("confirmed");
    const id = await insertSubmission({ kind: "create", payload: seedDoc });

    const res = await POST(reqWithBody(JSON.stringify({ notifyWatchers: true })), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(await submissionStatus(id)).toBe("approved");
    expect(await facilityRowCount()).toBe(1);
  });

  it("503s without approving when the watcher check itself fails, logging a SQLSTATE and nothing else", async () => {
    const id = await watchedUpdate();
    // DrizzleQueryError-shaped: the message embeds bound params, the code is on the error.
    const secret = "subscriber-secret@example.com";
    const failure = Object.assign(new Error(`Failed query: select ... params: ${secret}`), {
      code: "57P01",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The first db.select() on this request is approvalWatcherCount's own lookup.
    const selectSpy = vi.spyOn(tdb.db, "select").mockImplementationOnce(() => {
      throw failure;
    });

    let res: Response;
    let logged: string;
    try {
      res = await POST(req(), { params: Promise.resolve({ id }) });
      logged = errorSpy.mock.calls.flat().map(String).join(" ");
    } finally {
      selectSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "could not verify watchers; approval refused" });
    expect(approveSubmission).not.toHaveBeenCalled();
    expect(sendChangeNotification).not.toHaveBeenCalled();
    expect(logged).toContain("approve watcher check failed (sqlstate: 57P01)");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("Failed query");
    expect(await submissionStatus(id)).toBe("pending");
    expect(await facilityStatus()).toBe(seedDoc.status);
  });
});
