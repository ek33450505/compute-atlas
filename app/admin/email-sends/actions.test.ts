import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockGetCookie, mockVerifySessionCookie, mockList } = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockVerifySessionCookie: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: mockGetCookie })) }));
vi.mock("@/lib/admin-session", () => ({
  SESSION_COOKIE_NAME: "admin_session",
  verifySessionCookie: mockVerifySessionCookie,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/email-sends-query", () => ({ listEmailSends: mockList, ADDRESS_LOOKUP_LIMIT: 200 }));

import { hashAddress } from "@/lib/email-sends";
import { lookupEmailSendsAction } from "./actions";
import { INITIAL_LOOKUP_STATE } from "./lookup-state";

const ADDRESS = "Secret.Reader@example.com";

function form(address: string): FormData {
  const fd = new FormData();
  fd.set("address", address);
  return fd;
}

describe("lookupEmailSendsAction", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CONTRIBUTE_IP_SALT = "test-salt";
    mockGetCookie.mockReturnValue({ value: "cookie" });
    mockVerifySessionCookie.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws Unauthorized and queries nothing without a session", async () => {
    mockVerifySessionCookie.mockReturnValue(false);
    await expect(lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(ADDRESS))).rejects.toThrow("Unauthorized");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("hashes the normalised address server-side and returns rows without the address", async () => {
    mockList.mockResolvedValue([
      {
        id: "r1",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        completedAt: null,
        kind: "confirm",
        outcome: "sent",
        targetType: null,
        targetId: null,
        runId: null,
        resendId: null,
        errorCode: null,
        subscriptionId: null,
        hashPrefix: "abcd1234",
      },
    ]);
    const result = await lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(ADDRESS));
    expect(mockList).toHaveBeenCalledWith({}, { emailHash: hashAddress("secret.reader@example.com"), limit: 200 });
    expect(result.message).toBe("1 send for that address.");
    expect(result.rows).toHaveLength(1);
    const serialised = JSON.stringify(result).toLowerCase();
    expect(serialised).not.toContain("secret.reader");
    expect(serialised).not.toContain(hashAddress(ADDRESS));
  });

  it("refuses with a generic message and no query when the salt is unset", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "");
    const result = await lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(ADDRESS));
    expect(result).toEqual({ message: "Address lookup isn't available in this environment.", rows: [] });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns at most 200 rows and asks the query for 200", async () => {
    const mk = (i: number) => ({
      id: `r${i}`, createdAt: new Date("2026-10-01T00:00:00Z"), completedAt: null, kind: "confirm",
      outcome: "sent", targetType: null, targetId: null, runId: null, resendId: null,
      errorCode: null, subscriptionId: null, hashPrefix: "abcd1234",
    });
    mockList.mockResolvedValue(Array.from({ length: 250 }, (_, i) => mk(i)));
    const result = await lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(ADDRESS));
    expect(result.rows).toHaveLength(200);
    expect(mockList).toHaveBeenCalledWith({}, expect.objectContaining({ limit: 200 }));
  });

  it.each(["", "   ", "not-an-address"])("returns a generic message for %j", async (bad) => {
    const result = await lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(bad));
    expect(result).toEqual({ message: "Enter an email address to look up.", rows: [] });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns a generic failure and logs only a code when the query throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockList.mockRejectedValue(Object.assign(new Error(`Failed query: params: ${ADDRESS}`), { code: "57P01" }));
    const result = await lookupEmailSendsAction(INITIAL_LOOKUP_STATE, form(ADDRESS));
    expect(result).toEqual({ message: "The lookup could not be completed.", rows: [] });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Secret.Reader");
    spy.mockRestore();
  });
});
