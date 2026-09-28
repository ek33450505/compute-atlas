// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// The SSRF guard in scripts/discovery/net-guard.ts resolves DNS for real
// (via node:dns/promises) whenever a caller doesn't inject its own
// resolveDeps — which route.ts's `triageUrl(url)` call deliberately doesn't
// (production wants real resolution). Mocked here so every "example.com"-ish
// URL in this suite resolves to a benign address without ever touching real
// DNS. Mirrors scripts/discovery/fetch-page-text.test.ts's SAFE_RESOLVE_DEPS.
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

// `after()` throws "called outside a request scope" unless invoked inside a
// real Next.js request lifecycle, which this suite (calling POST directly)
// never sets up. Mocked to run the task immediately and capture its promise
// in `pendingAfter` so tests can deterministically await the triage phase
// (in production it runs post-response for latency reasons — see route.ts).
let pendingAfter: Promise<unknown> | undefined;
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      pendingAfter = Promise.resolve().then(task);
    },
  };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { intakeAttemptsTable, leadsTable } from "@/lib/db/schema";
import { RATE_LIMIT_MAX, hashIp } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";
import type { LeadTriage } from "@/lib/leads";

// Imported after the mocks above so the mocked modules are in effect.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** A real fetch `Response`, matching fetch-page-text.ts's expectations
 * (`.status`, `.ok`, `.headers`, a streamable `.body`). */
function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html" } });
}

async function flushAfter(): Promise<void> {
  await pendingAfter;
}

let tdb: TestDbHandle;

/**
 * Seeds `n` "leads" attempt rows for a raw IP, pre-hashed the way the route
 * does. This is what the limiter counts — seeding `leads` rows (as these tests
 * used to) no longer affects it at all.
 */
async function seedAttempts(ip: string, n: number): Promise<void> {
  const submitterIpHash = hashIp(ip);
  for (let i = 0; i < n; i++) {
    await tdb.db.insert(intakeAttemptsTable).values({ surface: "leads", submitterIpHash });
  }
}

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  // lib/lead-dedupe.ts reads via getAllFacilities -> loadFacilities, which
  // now gates on readsUseDatabase() (see lib/db/client.ts) rather than
  // hasDatabaseUrl() directly.
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  pendingAfter = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("POST /api/leads", () => {
  it("stages a valid lead with status new", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<title>Some Site</title>")));

    const res = await POST(req({ url: "https://example.com/tip", note: "worth checking" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await flushAfter();

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/tip");
    expect(rows[0].status).toBe("new");
  });

  it("rejects a javascript: URL with 400 and writes nothing", async () => {
    const res = await POST(req({ url: "javascript:alert(1)" }));
    expect(res.status).toBe(400);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0);
  });

  it("honeypot: returns 201 ok but inserts zero rows", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const res = await POST(req({ url: "https://example.com/tip", website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0); // the row count, not just the status — a status-only check can't fail here
    expect(fetchImpl).not.toHaveBeenCalled(); // tripped before any triage fetch is attempted
  });

  it("honeypot filled AND url invalid: still 201 with zero rows, never reaches schema validation", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const res = await POST(req({ url: "javascript:alert(1)", website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honeypot check tolerates a non-object JSON body without throwing", async () => {
    const stringRes = await POST(req("just a string"));
    expect(stringRes.status).toBe(400); // falls through to createLead's schema parse, no throw

    const nullRes = await POST(req(null));
    expect(nullRes.status).toBe(400);

    const arrayRes = await POST(req([1, 2, 3]));
    expect(arrayRes.status).toBe(400);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const badReq = new Request("http://localhost/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("rate-limits a 6th lead from the same ip within the window", async () => {
    const ip = "203.0.113.9";
    // Seeds ATTEMPT rows, not `leads` rows: the limiter counts
    // `intake_attempts` now, because counting leads made every non-inserting
    // path free (see `checkIntakeRateLimit` in lib/rate-limit.ts).
    await seedAttempts(ip, RATE_LIMIT_MAX);

    const res = await POST(req({ url: "https://example.com/sixth" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0); // the 6th attempt must not have landed
  });

  it("buckets by cf-connecting-ip, not a spoofed leftmost x-forwarded-for", async () => {
    const trustedIp = "203.0.113.11";
    await seedAttempts(trustedIp, RATE_LIMIT_MAX);

    // A different leftmost x-forwarded-for entry on every request is exactly
    // what defeated the naive leftmost-x-forwarded-for extraction
    // lib/rate-limit.ts once had, in production (see lib/rate-limit.ts's
    // extractTrustedClientIp doc comment); cf-connecting-ip must still win.
    const res = await POST(
      req(
        { url: "https://example.com/spoofed-sixth" },
        { "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": trustedIp }
      )
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(0); // the spoofed-XFF attempt must not have landed
  });

  it("does NOT count pre-existing `leads` rows — the cap counts attempts, not outcomes", async () => {
    const ip = "203.0.113.88";
    const ipHash = hashIp(ip);
    for (let i = 0; i < RATE_LIMIT_MAX + 3; i++) {
      await tdb.db.insert(leadsTable).values({ url: `https://example.com/prior-${i}`, submitterIpHash: ipHash });
    }
    const res = await POST(req({ url: "https://example.com/fresh" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(201);
  });

  it("counts a honeypot-tripping request, a Zod failure and an unparseable body", async () => {
    const ip = "198.51.100.71";
    const attemptsFor = async () =>
      tdb.db
        .select()
        .from(intakeAttemptsTable)
        .where(eq(intakeAttemptsTable.submitterIpHash, hashIp(ip)));

    const honeypot = await POST(
      req({ url: "https://example.com/bot", website: "spam" }, { "x-forwarded-for": ip })
    );
    expect(honeypot.status).toBe(201);
    await POST(req({ url: "not-a-url" }, { "x-forwarded-for": ip }));
    await POST(
      new Request("http://localhost/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: "{not json",
      })
    );

    // Zero leads written, three units of budget spent — all three were free before.
    expect(await tdb.db.select().from(leadsTable)).toHaveLength(0);
    const attempts = await attemptsFor();
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.surface === "leads")).toBe(true);
  });

  it("does NOT count an already-refused (429) request", async () => {
    const ip = "198.51.100.72";
    await seedAttempts(ip, RATE_LIMIT_MAX);
    const res = await POST(req({ url: "https://example.com/x" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);
    const attempts = await tdb.db
      .select()
      .from(intakeAttemptsTable)
      .where(eq(intakeAttemptsTable.submitterIpHash, hashIp(ip)));
    expect(attempts).toHaveLength(RATE_LIMIT_MAX);
  });

  it("trips the honeypot on a non-string truthy value, still returning the generic 201", async () => {
    // `{"website":1, "url":"not-a-url"}` used to fall past a
    // `typeof === "string"` gate into Zod and answer 400 with `issues`, while
    // `{"website":"x", ...}` answered 201 — the type flip revealed the honeypot.
    for (const website of [1, 0, true, { a: 1 }, ["x"]]) {
      const res = await POST(req({ url: "not-a-url", website }));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await tdb.db.select().from(leadsTable)).toHaveLength(0);
  });

  it("does NOT trip on an empty-string honeypot — a real browser's hidden input still submits", async () => {
    const res = await POST(req({ url: "https://example.com/honest", website: "" }));
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(leadsTable)).toHaveLength(1);
  });

  it("a triage fetch failure still yields 201 with the lead row present (triage=null-ish)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("simulated network failure");
      })
    );

    const res = await POST(req({ url: "https://example.com/unreachable" }));
    expect(res.status).toBe(201);
    await flushAfter();

    const rows = await tdb.db.select().from(leadsTable);
    expect(rows).toHaveLength(1); // the tip must survive a failed fetch
    const triage = rows[0].triage as LeadTriage | null;
    // A failed fetch records ok:false, never leaves the row looking like an
    // untriaged (`triage === null`) OR successful lead.
    expect(triage).not.toBeNull();
    expect(triage?.ok).toBe(false);
  });

  it("a successful triage writes httpStatus, finalUrl, and title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        htmlResponse("<html><head><title>  New   Data Center &amp; Site  </title></head><body>hi</body></html>")
      )
    );

    const res = await POST(req({ url: "https://example.com/announcement" }));
    expect(res.status).toBe(201);
    await flushAfter();

    const rows = await tdb.db.select().from(leadsTable);
    const triage = rows[0].triage as LeadTriage;
    expect(triage.ok).toBe(true);
    expect(triage.httpStatus).toBe(200);
    expect(triage.finalUrl).toBe("https://example.com/announcement");
    expect(triage.title).toBe("New Data Center & Site");
  });

  it("SSRF: a lead pointing at a private/blocked address never reaches fetch and triages ok:false", async () => {
    // 127.0.0.1 is a literal blocked address (scripts/discovery/net-guard.ts
    // isBlockedIpv4) — caught before any DNS resolution or connection
    // attempt. If triageUrl ever bypassed fetchPageText's guard (e.g. a bare
    // `fetch()` on the raw URL), this fetchImpl WOULD be called.
    const fetchImpl = vi.fn(async () => htmlResponse("<title>should never be reached</title>"));
    vi.stubGlobal("fetch", fetchImpl);

    const res = await POST(req({ url: "http://127.0.0.1/admin" }));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(fetchImpl).not.toHaveBeenCalled();
    const rows = await tdb.db.select().from(leadsTable);
    const triage = rows[0].triage as LeadTriage;
    expect(triage.ok).toBe(false);
    expect(triage.error).toMatch(/blocked/i);
  });

  it("dedupe: flags a live facility whose sources[].url matches the submitted URL", async () => {
    const dupeUrl = "https://example.com/permit-filing";
    await seedFacility(tdb.db, {
      ...seedDoc,
      id: "dedupe-test-facility",
      sources: [{ url: dupeUrl, label: "Permit filing", retrievedAt: "2026-01-01", kind: "permit" }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<title>Permit</title>")));

    const res = await POST(req({ url: dupeUrl }));
    expect(res.status).toBe(201);
    await flushAfter();

    const rows = await tdb.db.select().from(leadsTable);
    const triage = rows[0].triage as LeadTriage;
    expect(triage.duplicateFacilityIds).toEqual(["dedupe-test-facility"]);
  });
});
