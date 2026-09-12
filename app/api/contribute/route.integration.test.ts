// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { submissionsTable, submissionNotifyRequestsTable } from "@/lib/db/schema";
import { EMAIL_SEND_CAP_MAX, hashIp } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Import the route handler AFTER the mocks above so its transitive imports
// (lib/contribute.ts, lib/rate-limit.ts, lib/data.ts -> lib/db/client.ts)
// resolve against the mocked module.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // 123net-dc1-southfield-mi

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  // Corrections read the target facility via getFacilityById -> loadFacilities,
  // which gates on readsUseDatabase() (see lib/db/client.ts), not
  // hasDatabaseUrl() directly. Without this, "existing" silently falls back to
  // the bundled data/facilities.json snapshot instead of the row seeded into
  // tdb.db below — the correction tests would still pass (seedDoc is an
  // unmodified copy of its JSON entry) but a seeded field that DIFFERS from
  // the JSON snapshot would be silently ignored. Same pattern as
  // app/api/leads/route.integration.test.ts and
  // app/api/subscribe/route.integration.test.ts.
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

const validCreateBody = {
  kind: "create" as const,
  name: "New Facility",
  operator: "Acme Compute",
  state: "TX",
  lat: 30.5,
  lon: -97.5,
  sourceUrl: "https://example.com/article",
};

describe("POST /api/contribute (public, unauthenticated happy path)", () => {
  it("stages a pending create submission with public-contribution provenance", async () => {
    const res = await POST(req(validCreateBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("create");
    expect(
      (rows[0].provenance as { discoveredBy?: string }).discoveredBy
    ).toBe("public-contribution");
  });

  it("honeypot: returns 201 ok but inserts zero submission rows", async () => {
    const res = await POST(req({ ...validCreateBody, website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(0);
  });

  it("honeypot pre-parse: a schema-invalid payload with a filled honeypot still returns 201 and writes nothing", async () => {
    // Missing required create fields (name, operator, state, lat, lon) and an
    // invalid sourceUrl — this must never reach Zod validation, because the
    // honeypot check now runs on the raw body before submitContribution's
    // schema parse. Pre-fix, this payload would 400 (schema-invalid) instead
    // of silently 201-ing like a real bot response.
    const res = await POST(req({ kind: "create", website: "spam", sourceUrl: "not-a-valid-url" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(0);
  });

  it("rate-limits a 6th submission from the same ip within the window", async () => {
    const ip = "203.0.113.7";
    const ipHash = hashIp(ip);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(submissionsTable).values({
        kind: "create",
        payload: seedDoc,
        provenance: { sources: ["https://example.com/x"], discoveredBy: "test", submitterIpHash: ipHash },
      });
    }

    const res = await POST(req(validCreateBody, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(5); // the 6th attempt must not have landed
  });

  it("buckets by cf-connecting-ip, not a spoofed leftmost x-forwarded-for", async () => {
    const trustedIp = "203.0.113.13";
    const ipHash = hashIp(trustedIp);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(submissionsTable).values({
        kind: "create",
        payload: seedDoc,
        provenance: { sources: ["https://example.com/x"], discoveredBy: "test", submitterIpHash: ipHash },
      });
    }

    // A different leftmost x-forwarded-for entry on every request is exactly
    // what defeated the naive leftmost-x-forwarded-for extraction
    // lib/rate-limit.ts once had, in production (see lib/rate-limit.ts's
    // extractTrustedClientIp doc comment); cf-connecting-ip must still win.
    const res = await POST(
      req(validCreateBody, { "x-forwarded-for": "198.51.100.9", "cf-connecting-ip": trustedIp })
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(5); // the spoofed-XFF attempt must not have landed
  });

  it("correction: stages a pending update submission targeting an existing facility", async () => {
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(
      req({
        kind: "correction",
        targetFacilityId: seedDoc.id,
        field: "operator",
        value: "New Op",
        sourceUrl: "https://example.com/correction",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("update");
    expect(rows[0].targetFacilityId).toBe(seedDoc.id);
    expect((rows[0].payload as { operator?: string }).operator).toBe("New Op");

    const submissionsAfter = await tdb.db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.targetFacilityId, seedDoc.id));
    expect(submissionsAfter).toHaveLength(1);
  });

  it("correction: a nested-object field (water) merges into the existing sub-object instead of replacing it", async () => {
    // seedDoc's own water has no reportedMgd — extend a local copy (not the
    // shared fixture) so the preservation assertion below is meaningful.
    const seedWithReportedMgd: Facility = {
      ...seedDoc,
      water: { ...seedDoc.water, reportedMgd: 5.2 },
    };
    await seedFacility(tdb.db, seedWithReportedMgd);

    const res = await POST(
      req({
        kind: "correction",
        targetFacilityId: seedWithReportedMgd.id,
        field: "water",
        value: "closed_loop",
        sourceUrl: "https://example.com/correction",
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].kind).toBe("update");
    expect(rows[0].targetFacilityId).toBe(seedWithReportedMgd.id);

    const payload = rows[0].payload as {
      water?: { coolingType?: string; reportedMgd?: number; notes?: string };
    };
    expect(payload.water?.coolingType).toBe("closed_loop");
    // The point of this test: sibling sub-fields survive the merge.
    expect(payload.water?.reportedMgd).toBe(5.2);
    expect(payload.water?.notes).toBe(seedWithReportedMgd.water?.notes);
  });

  it("correction: an out-of-vocabulary enum value for a nested field (water) is rejected and writes no row", async () => {
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(
      req({
        kind: "correction",
        targetFacilityId: seedDoc.id,
        field: "water",
        value: "definitely-not-a-cooling-type",
        sourceUrl: "https://example.com/correction",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBeUndefined();

    const rows = await tdb.db.select().from(submissionsTable);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/contribute — 'email me when reviewed' (SUBMISSION_NOTIFY_ENABLED)", () => {
  it("flag OFF: a valid notifyEmail is silently ignored — 201, zero notify rows", async () => {
    const res = await POST(req({ ...validCreateBody, notifyEmail: "contributor@example.com" }));
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);

    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(1);
    expect(await tdb.db.select().from(submissionNotifyRequestsTable)).toHaveLength(0);
  });

  it("flag OFF: a malformed notifyEmail does not change the response — this is the oracle test the field is kept out of contributeInputSchema to prevent", async () => {
    // Identical body to the flag-ON "malformed notifyEmail" case below (400
    // there) — proving it's the flag, not the value, that decides the outcome.
    const res = await POST(req({ ...validCreateBody, notifyEmail: "x" }));
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);

    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(1);
    expect(await tdb.db.select().from(submissionNotifyRequestsTable)).toHaveLength(0);
  });

  it("flag ON: records exactly one row, email lowercased + trimmed", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const res = await POST(req({ ...validCreateBody, notifyEmail: "  MiXeD@Example.COM  " }));
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);

    const rows = await tdb.db.select().from(submissionNotifyRequestsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("mixed@example.com");

    const submissions = await tdb.db.select().from(submissionsTable);
    expect(rows[0].submissionId).toBe(submissions[0].id);
  });

  it("flag ON: notifyEmail never reaches the stored submission payload or provenance", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const res = await POST(req({ ...validCreateBody, notifyEmail: "should-not-leak@example.com" }));
    expect(res.status).toBe(201);

    const submissions = await tdb.db.select().from(submissionsTable);
    expect(submissions).toHaveLength(1);
    expect(JSON.stringify(submissions[0].payload)).not.toContain("should-not-leak@example.com");
    expect(JSON.stringify(submissions[0].provenance)).not.toContain("should-not-leak@example.com");
  });

  it("flag ON, correction kind: a notify row is written too", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(
      req({
        kind: "correction",
        targetFacilityId: seedDoc.id,
        field: "operator",
        value: "New Op",
        sourceUrl: "https://example.com/correction",
        notifyEmail: "correction-notify@example.com",
      })
    );
    expect(res.status).toBe(201);

    const submissions = await tdb.db.select().from(submissionsTable);
    expect(submissions).toHaveLength(1);
    const rows = await tdb.db.select().from(submissionNotifyRequestsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("correction-notify@example.com");
    expect(rows[0].submissionId).toBe(submissions[0].id);
  });

  it("flag ON, malformed notifyEmail: 400, zero notify rows, and zero submissions created", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const res = await POST(req({ ...validCreateBody, notifyEmail: "x" }));
    expect(res.status).toBe(400);
    // issue.path must be ["notifyEmail"], not [] — the form's client-side
    // issuesToFieldMap keys errors by issue.path[0], and a path-less issue
    // can't attach to the email field (see notifyEmailFieldSchema's comment
    // in lib/contribute.ts).
    const body = await res.json();
    expect(body.issues?.[0]?.path).toEqual(["notifyEmail"]);

    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
    expect(await tdb.db.select().from(submissionNotifyRequestsTable)).toHaveLength(0);
  });

  it("flag ON, honeypot tripped: zero notify rows and zero submissions", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");

    const res = await POST(req({ ...validCreateBody, website: "spam", notifyEmail: "bot@example.com" }));
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);

    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(0);
    expect(await tdb.db.select().from(submissionNotifyRequestsTable)).toHaveLength(0);
  });

  it("flag ON: per-address cap — at EMAIL_SEND_CAP_MAX outstanding requests, writes no new row but still succeeds", async () => {
    vi.stubEnv("SUBMISSION_NOTIFY_ENABLED", "true");
    const email = "capped@example.com";
    for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) {
      await tdb.db.insert(submissionNotifyRequestsTable).values({ submissionId: randomUUID(), email });
    }

    const res = await POST(req({ ...validCreateBody, notifyEmail: email }));
    expect(res.status).toBe(201);
    expect((await res.json()).ok).toBe(true);

    // The submission itself still succeeds — only the notify row is skipped.
    expect(await tdb.db.select().from(submissionsTable)).toHaveLength(1);
    const rows = await tdb.db.select().from(submissionNotifyRequestsTable);
    expect(rows).toHaveLength(EMAIL_SEND_CAP_MAX); // unchanged — no new row added
  });
});
