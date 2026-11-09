// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// `after()` throws outside a Next.js request scope; run the task at once and keep its promise so tests can await the send.
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

// Passes through to the real function by default; one test overrides it to simulate a throw.
vi.mock("@/lib/dataset-grants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dataset-grants")>();
  return { ...actual, requestDatasetAccess: vi.fn(actual.requestDatasetAccess) };
});

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";
import * as rateLimit from "@/lib/rate-limit";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { datasetAccessGrantsTable, emailSuppressionsTable, intakeAttemptsTable } from "@/lib/db/schema";
import { DATASET_ROTATION_COOLDOWN_MS, requestDatasetAccess, verifyDatasetRequest } from "@/lib/dataset-grants";
import { EMAIL_SEND_CAP_MAX, RATE_LIMIT_MAX, hashIp } from "@/lib/rate-limit";
import { hashToken } from "@/lib/token-hash";

// Imported after the mocks above so the mocked modules are in effect.
import { GET, OPTIONS, POST } from "./route";

// cf-connecting-ip is honoured only alongside a valid edge secret (lib/edge-secret.ts).
process.env.EDGE_SHARED_SECRET = "test-edge-secret";
const EDGE_HEADER = { "x-edge-shared-secret": "test-edge-secret" };

let tdb: TestDbHandle;
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

const formBody = (over: Record<string, unknown> = {}) => ({
  email: "reporter@example.com",
  name: "Pat Reporter",
  organization: "The Gazette",
  role: "Data editor",
  category: "journalist",
  intendedUse: "Cross-checking siting announcements for a story.",
  links: ["https://example.com/story"],
  attributionAck: true,
  termsAccepted: true,
  ...over,
});

function req(body: unknown, ip: string = freshIp(), raw?: string): Request {
  return new Request("http://localhost/api/access/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": ip, ...EDGE_HEADER },
    body: raw ?? JSON.stringify(body),
  });
}

const flushAfter = async () => {
  await pendingAfter;
};

const attempts = async () => (await tdb.db.select().from(intakeAttemptsTable)).length;
const rows = () => tdb.db.select().from(datasetAccessGrantsTable);

let seed = 0;
async function insertGrant(over: Partial<typeof datasetAccessGrantsTable.$inferInsert> = {}) {
  const [row] = await tdb.db
    .insert(datasetAccessGrantsTable)
    .values({
      email: "reporter@example.com",
      name: "Seed",
      category: "journalist",
      intendedUse: "seed",
      attributionAckAt: new Date(),
      termsVersion: "seed-terms",
      verifyTokenHash: hashToken(`seed-verify-${seed++}`),
      ...over,
    })
    .returning();
  return row;
}

/** The response as an observer sees it: status, exact body text and headers minus Date. */
async function observe(res: Response) {
  const headers = [...res.headers.entries()].filter(([k]) => k !== "date").sort();
  return { status: res.status, text: await res.text(), headers };
}

const TOKEN_RE = /[A-Za-z0-9_-]{43}/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
  vi.mocked(dbClient.getDb).mockClear();
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("CONTACT_TO_EMAIL", "ed@example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("POST /api/access/request — kill switch", () => {
  it("answers 403 no-store, with no DB call and no email, when the flag is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    const res = await POST(req(formBody()));
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ error: "Not available" });
    expect(dbClient.getDb).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/access/request — enumeration symmetry", () => {
  const scenarios: Array<[string, () => Promise<void>, Record<string, unknown>?]> = [
    ["new address", async () => {}],
    ["existing unverified inside the cooldown", async () => void (await insertGrant({ status: "unverified" }))],
    ["pending_review", async () => void (await insertGrant({ status: "pending_review" }))],
    [
      "active (live)",
      async () =>
        void (await insertGrant({ status: "active", expiresAt: new Date(Date.now() + 30 * 86_400_000) })),
    ],
    ["previously rejected", async () => void (await insertGrant({ status: "rejected" }))],
    [
      "over the per-address row cap",
      async () => {
        for (let i = 0; i < EMAIL_SEND_CAP_MAX; i++) await insertGrant({ status: "rejected" });
      },
    ],
    ["honeypot", async () => {}, { website: "x" }],
    [
      "globally suppressed",
      async () => void (await tdb.db.insert(emailSuppressionsTable).values({ email: "reporter@example.com", source: "admin" })),
    ],
  ];

  it("returns the identical status, body and headers on every valid path, with no token or id in the body", async () => {
    const seen: Array<{ name: string; obs: Awaited<ReturnType<typeof observe>> }> = [];
    for (const [name, setup, extra] of scenarios) {
      await tdb.reset();
      await setup();
      const res = await POST(req(formBody(extra)));
      await flushAfter();
      pendingAfter = undefined;
      const obs = await observe(res);
      expect(obs.text, name).not.toMatch(TOKEN_RE);
      expect(obs.text, name).not.toMatch(UUID_RE);
      seen.push({ name, obs });
    }
    expect(seen[0].obs.status).toBe(202);
    expect(seen[0].obs.text).toBe('{"ok":true}');
    for (const { name, obs } of seen) {
      expect(obs, name).toEqual(seen[0].obs);
    }
  });

  it("sends the verify mail only for a new address, with an /access/confirm link", async () => {
    await POST(req(formBody()));
    await flushAfter();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const payload = resendSendMock.mock.calls[0][0];
    expect(payload.to).toBe("reporter@example.com");
    expect(payload.text).toMatch(/https:\/\/example\.test\/access\/confirm\?token=[A-Za-z0-9_-]{43}/);
    expect((await rows())).toHaveLength(1);
  });

  it("sends one already-active mail with no token for a live grant", async () => {
    await insertGrant({ status: "active", expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    await POST(req(formBody()));
    await flushAfter();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0][0].to).toBe("reporter@example.com");
    expect(resendSendMock.mock.calls[0][0].text).not.toMatch(TOKEN_RE);
    expect(await rows()).toHaveLength(1);
  });

  it("honeypot: no mail and no grant row", async () => {
    await POST(req(formBody({ website: "x" })));
    await flushAfter();
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("inside the cooldown: the identical 202, no new mail, and the first token still verifies", async () => {
    const first = await POST(req(formBody()));
    await flushAfter();
    pendingAfter = undefined;
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const token = /token=([A-Za-z0-9_-]{43})/.exec(resendSendMock.mock.calls[0][0].text)?.[1] ?? "";
    const hashBefore = (await rows())[0].verifyTokenHash;

    const second = await POST(req(formBody()));
    await flushAfter();
    expect(await observe(second)).toEqual(await observe(first));
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect((await rows())[0].verifyTokenHash).toBe(hashBefore);
    expect(hashBefore).toBe(hashToken(token));
    expect(await verifyDatasetRequest(token)).toMatchObject({ outcome: "verified" });
  });

  it("past the cooldown: rotates the token and sends one new verify mail", async () => {
    const old = await insertGrant({ status: "unverified", createdAt: new Date(Date.now() - 2 * DATASET_ROTATION_COOLDOWN_MS) });
    await POST(req(formBody()));
    await flushAfter();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect((await rows())[0].verifyTokenHash).not.toBe(old.verifyTokenHash);
  });

  it("503s no-store with the fixed body and no mail when requestDatasetAccess throws after accounting succeeded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requestDatasetAccess).mockRejectedValueOnce(new Error("boom"));
    const res = await POST(req(formBody({ email: "boom@example.com" })));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ error: "Requests are temporarily unavailable. Please try again later." });
    await flushAfter();
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(await attempts()).toBe(1);
  });
});

describe("POST /api/access/request — validation and framing", () => {
  it("400s invalid input with the issues, no-store", async () => {
    const res = await POST(req(formBody({ email: "not-an-email" })));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const json = await res.json();
    expect(json.error).toBe("Invalid request");
    expect(Array.isArray(json.issues)).toBe(true);
  });

  it("400s invalid JSON and 413s an oversize body, both no-store", async () => {
    const bad = await POST(req(null, freshIp(), "{nope"));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("cache-control")).toContain("no-store");
    const big = await POST(req(null, freshIp(), JSON.stringify({ pad: "x".repeat(70 * 1024) })));
    expect(big.status).toBe(413);
    expect(big.headers.get("cache-control")).toContain("no-store");
  });

  it("answers GET 405 and OPTIONS with a preflight, no-store on the 405", async () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(OPTIONS().status).toBeLessThan(300);
  });
});

describe("POST /api/access/request — rate limit accounting", () => {
  it("records exactly one intake_attempts row on every path, including honeypot, invalid JSON and 400", async () => {
    const cases: Array<() => Request> = [
      () => req(formBody()),
      () => req(formBody({ website: "x" })),
      () => req(null, freshIp(), "{nope"),
      () => req(formBody({ email: "bad" })),
      () => req(null, freshIp(), JSON.stringify({ pad: "x".repeat(70 * 1024) })),
    ];
    for (const make of cases) {
      const before = await attempts();
      await POST(make());
      await flushAfter();
      expect(await attempts()).toBe(before + 1);
    }
  });

  it("429s past the per-IP cap, no-store, and records nothing for the refused request", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect((await POST(req(formBody({ email: `r${i}@example.com` }), ip))).status).toBe(202);
    }
    const before = await attempts();
    const res = await POST(req(formBody(), ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await attempts()).toBe(before);
  });

  it("503s no-store when the accounting throws", async () => {
    vi.spyOn(rateLimit, "checkIntakeRateLimit").mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(req(formBody()));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("keys the budget on the hashed IP", async () => {
    await POST(req(formBody(), "203.0.113.9"));
    const [row] = await tdb.db.select().from(intakeAttemptsTable);
    expect(row.surface).toBe("access-request");
    expect(row.submitterIpHash).toBe(hashIp(rateLimit.normaliseIpForBucketing("203.0.113.9")));
  });
});
