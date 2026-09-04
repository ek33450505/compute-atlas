// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// `after()` throws "called outside a request scope" unless invoked inside a
// real Next.js request lifecycle, which this suite (calling POST directly)
// never sets up. Mocked to run the task immediately and capture its promise
// in `pendingAfter` so tests can deterministically await the email-send
// phase. Mirrors app/api/access/request/route's identical mock.
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

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, seedFacility, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { hashIp } from "@/lib/rate-limit";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so the mocked modules are in effect.
import { POST } from "./route";

const seedDoc = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function flushAfter(): Promise<void> {
  await pendingAfter;
}

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
  // subscribeToTarget resolves the target facility via getFacilityById ->
  // loadFacilities, which gates on readsUseDatabase() (see lib/db/client.ts)
  // rather than hasDatabaseUrl() directly.
  vi.mocked(dbClient.readsUseDatabase).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  pendingAfter = undefined;
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("POST /api/subscribe", () => {
  it("stages a pending subscription with 201, and sends nothing when RESEND_API_KEY is unset", async () => {
    await seedFacility(tdb.db, seedDoc);

    const res = await POST(req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await flushAfter();

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends the confirm email once RESEND_API_KEY is set", async () => {
    await seedFacility(tdb.db, seedDoc);
    vi.stubEnv("RESEND_API_KEY", "test-key");

    const res = await POST(req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0];
    expect(args.to).toBe("reader@example.com");
  });

  it("rejects a malformed JSON body with 400", async () => {
    const badReq = new Request("http://localhost/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid email with 400 and writes nothing", async () => {
    const res = await POST(req({ email: "not-an-email", targetType: "facility", targetId: seedDoc.id }));
    expect(res.status).toBe(400);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
  });

  it("honeypot: returns 201 ok but inserts zero rows and never sends", async () => {
    await seedFacility(tdb.db, seedDoc);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const res = await POST(
      req({ email: "spammer@example.com", targetType: "facility", targetId: seedDoc.id, website: "spam" })
    );
    expect(res.status).toBe(201);
    expect(await tdb.db.select().from(subscriptionsTable)).toHaveLength(0);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("rate-limits a 6th request from the same ip within the window", async () => {
    await seedFacility(tdb.db, seedDoc);
    const ip = "203.0.113.14";
    const ipHash = hashIp(ip);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(subscriptionsTable).values({
        email: `user${i}@example.com`,
        targetType: "facility",
        targetId: seedDoc.id,
        status: "pending",
        confirmToken: `tok-${i}`,
        unsubscribeToken: `unsub-${i}`,
        submitterIpHash: ipHash,
      });
    }

    const res = await POST(
      req({ email: "reader@example.com", targetType: "facility", targetId: seedDoc.id }, { "x-forwarded-for": ip })
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(5); // the 6th attempt must not have landed
  });

  it("buckets by cf-connecting-ip, not a spoofed leftmost x-forwarded-for", async () => {
    await seedFacility(tdb.db, seedDoc);
    const trustedIp = "203.0.113.15";
    const ipHash = hashIp(trustedIp);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(subscriptionsTable).values({
        email: `spoof-user${i}@example.com`,
        targetType: "facility",
        targetId: seedDoc.id,
        status: "pending",
        confirmToken: `spoof-tok-${i}`,
        unsubscribeToken: `spoof-unsub-${i}`,
        submitterIpHash: ipHash,
      });
    }

    // A different leftmost x-forwarded-for entry on every request is exactly
    // what defeated extractClientIp in production (see lib/rate-limit.ts's
    // extractTrustedClientIp doc comment); cf-connecting-ip must still win.
    const res = await POST(
      req(
        { email: "reader@example.com", targetType: "facility", targetId: seedDoc.id },
        { "x-forwarded-for": "198.51.100.10", "cf-connecting-ip": trustedIp }
      )
    );
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(subscriptionsTable);
    expect(rows).toHaveLength(5); // the spoofed-XFF attempt must not have landed
  });
});
