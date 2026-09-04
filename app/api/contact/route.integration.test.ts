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
// in `pendingAfter` so tests can deterministically await the email-send phase
// (in production it runs post-response — see route.ts). Mirrors
// app/api/leads/route.integration.test.ts's identical mock.
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

// The "resend" package is never installed against a real API in tests —
// stubbed per-test via `resendSendMock` so happy-path sends can be asserted
// without a network call, and left un-stubbed (RESEND_API_KEY unset) for the
// "email not configured" cases, which exercise lib/email.ts's real early
// return.
const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { contactMessagesTable } from "@/lib/db/schema";
import { hashIp, normaliseIpForBucketing } from "@/lib/rate-limit";

// Imported after the mocks above so the mocked modules are in effect.
import { POST } from "./route";

function req(body: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function flushAfter(): Promise<void> {
  await pendingAfter;
}

const VALID = {
  name: "Jamie Rivera",
  email: "jamie@example.com",
  topic: "press",
  message: "This is a message with well over twenty characters in it.",
};

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
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

describe("POST /api/contact", () => {
  it("stages a valid message with 201, and emailSent stays false when RESEND_API_KEY is unset", async () => {
    const res = await POST(req(VALID));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    await flushAfter();

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(VALID.name);
    expect(rows[0].email).toBe(VALID.email);
    expect(rows[0].topic).toBe(VALID.topic);
    expect(rows[0].emailSent).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("sends the notification email and records emailSent=true once RESEND_API_KEY and CONTACT_TO_EMAIL are set", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.com");

    const res = await POST(req(VALID));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const sentArgs = resendSendMock.mock.calls[0][0];
    expect(sentArgs.to).toBe("maintainer@example.com");
    expect(sentArgs.replyTo).toBe(VALID.email);
    expect(sentArgs.subject).toContain("press");

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows[0].emailSent).toBe(true);
  });

  it("row still stores, emailSent=false, when CONTACT_TO_EMAIL is unset even with a key present", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");

    const res = await POST(req(VALID));
    expect(res.status).toBe(201);
    await flushAfter();

    expect(resendSendMock).not.toHaveBeenCalled();
    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailSent).toBe(false);
  });

  it("a Resend send failure still leaves the row stored with emailSent=false, never a 500", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.com");
    resendSendMock.mockRejectedValue(new Error("simulated network failure"));

    const res = await POST(req(VALID));
    expect(res.status).toBe(201);
    await flushAfter();

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].emailSent).toBe(false);
  });

  it("honeypot: returns 201 ok but inserts zero rows and never sends", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("CONTACT_TO_EMAIL", "maintainer@example.com");

    const res = await POST(req({ ...VALID, website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0); // the row count, not just the status
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("honeypot filled AND email invalid: still 201 with zero rows, never reaches schema validation", async () => {
    const res = await POST(req({ ...VALID, email: "not-an-email", website: "spam" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0);
  });

  it("honeypot check tolerates a non-object JSON body without throwing", async () => {
    const stringRes = await POST(req("just a string"));
    expect(stringRes.status).toBe(400); // falls through to schema parse, no throw

    const nullRes = await POST(req(null));
    expect(nullRes.status).toBe(400);

    const arrayRes = await POST(req([1, 2, 3]));
    expect(arrayRes.status).toBe(400);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const badReq = new Request("http://localhost/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("rejects each length cap and a bad email with 400 and writes nothing", async () => {
    const cases = [
      { ...VALID, name: "" },
      { ...VALID, name: "a".repeat(121) },
      { ...VALID, email: "not-an-email" },
      { ...VALID, topic: "sales" },
      { ...VALID, message: "too short" },
      { ...VALID, message: "a".repeat(4001) },
    ];
    for (const body of cases) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
    }

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0);
  });

  it("rate-limits a 6th message from the same ip within the window", async () => {
    const ip = "203.0.113.9";
    const ipHash = hashIp(ip);
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(contactMessagesTable).values({
        name: VALID.name,
        email: VALID.email,
        topic: VALID.topic,
        message: `${VALID.message} ${i}`,
        submitterIpHash: ipHash,
      });
    }

    const res = await POST(req(VALID, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(5); // the 6th attempt must not have landed
  });

  it("buckets two different IPv6 addresses in the same /64 together (RFC 4941 rotation)", async () => {
    // Same /64 prefix (first four groups), different interface identifiers —
    // exactly what a residential IPv6 client rotates through automatically
    // via privacy extensions, no attacker required. Without
    // normaliseIpForBucketing these hash to different buckets and the limit
    // never fires.
    const firstAddressInBlock = "2001:db8:1:2:3:4:5:6";
    const secondAddressInBlock = "2001:db8:1:2:ffff:ffff:ffff:ffff";
    const ipHash = hashIp(normaliseIpForBucketing(firstAddressInBlock));
    for (let i = 0; i < 5; i++) {
      await tdb.db.insert(contactMessagesTable).values({
        name: VALID.name,
        email: VALID.email,
        topic: VALID.topic,
        message: `${VALID.message} ${i}`,
        submitterIpHash: ipHash,
      });
    }

    const res = await POST(req(VALID, { "cf-connecting-ip": secondAddressInBlock }));
    expect(res.status).toBe(429);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(5); // the 6th attempt, from a rotated address in the same /64, must not have landed
  });
});
