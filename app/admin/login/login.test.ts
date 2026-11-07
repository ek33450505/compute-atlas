import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const setMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: setMock })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

const { pbkdf2Spy, realDerive } = vi.hoisted(() => ({
  pbkdf2Spy: vi.fn(),
  realDerive: { fn: undefined as unknown as (secret: string, salt: string) => Buffer },
}));
vi.mock("./password-hash", async () => {
  const actual = await vi.importActual<typeof import("./password-hash")>("./password-hash");
  realDerive.fn = actual.derivePasswordHash;
  return { derivePasswordHash: pbkdf2Spy };
});

const { reserveMock, releaseMock, ipRef } = vi.hoisted(() => ({
  reserveMock: vi.fn(),
  releaseMock: vi.fn(),
  ipRef: { value: "203.0.113.9" },
}));
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return {
    extractTrustedClientIp: () => ipRef.value,
    normaliseIpForBucketing: actual.normaliseIpForBucketing,
    hashIp: (ip: string) => `hash:${ip}`,
    reserveAdminLoginAttempt: reserveMock,
    releaseAdminLoginAttempt: releaseMock,
  };
});

import { login } from "./actions";
import { __resetLoginAttempts } from "./login-guards";

const TOKEN = "correct-horse";

function form(password: string): FormData {
  const f = new FormData();
  f.set("password", password);
  return f;
}

describe("login (DB-backed limiter)", () => {
  const saved = { t: process.env.API_ADMIN_TOKEN, s: process.env.API_ADMIN_TOKEN_SALT };
  beforeEach(() => {
    process.env.API_ADMIN_TOKEN = TOKEN;
    process.env.API_ADMIN_TOKEN_SALT = "salt";
    ipRef.value = "203.0.113.9";
    setMock.mockReset();
    pbkdf2Spy.mockReset().mockImplementation((secret: string, salt: string) => realDerive.fn(secret, salt));
    reserveMock.mockReset().mockResolvedValue({ ok: true, id: "row-1" });
    releaseMock.mockReset().mockResolvedValue(undefined);
    __resetLoginAttempts();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.t === undefined) delete process.env.API_ADMIN_TOKEN;
    else process.env.API_ADMIN_TOKEN = saved.t;
    if (saved.s === undefined) delete process.env.API_ADMIN_TOKEN_SALT;
    else process.env.API_ADMIN_TOKEN_SALT = saved.s;
  });

  it("computes at most one PBKDF2 for a request after the expected hash is cached", async () => {
    await login({}, form("nope")); // warms the per-process expected-hash cache
    pbkdf2Spy.mockClear();
    await login({}, form("nope-again"));
    expect(pbkdf2Spy).toHaveBeenCalledTimes(1);
  });

  it("keeps the reserved row on a wrong password (failures persist)", async () => {
    const res = await login({}, form("nope"));
    expect(res.error).toBe("Incorrect password.");
    expect(reserveMock).toHaveBeenCalledWith("hash:203.0.113.9");
    expect(releaseMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("releases the reserved row on success and sets a v3 cookie", async () => {
    await expect(login({}, form(TOKEN))).rejects.toThrow("NEXT_REDIRECT:/admin/submissions");
    expect(releaseMock).toHaveBeenCalledWith("row-1");
    expect(setMock.mock.calls[0][1]).toMatch(/^v3\./);
  });

  it("refuses even the CORRECT password when the reservation is over budget", async () => {
    reserveMock.mockResolvedValue({ ok: false, id: "row-x" });
    pbkdf2Spy.mockClear();
    const res = await login({}, form(TOKEN));
    expect(res.error).toBe("Incorrect password.");
    expect(setMock).not.toHaveBeenCalled();
    expect(pbkdf2Spy).not.toHaveBeenCalled();
  });

  it("fails closed when the reservation throws, even with the correct password", async () => {
    reserveMock.mockRejectedValue(Object.assign(new Error("Failed query: params: secret"), { code: "57P01" }));
    const res = await login({}, form(TOKEN));
    expect(res.error).toMatch(/temporarily unavailable/);
    expect(setMock).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("57P01");
    expect(logged).not.toContain("secret");
  });

  it("still logs in if releasing the row throws (row stays as a failure)", async () => {
    releaseMock.mockRejectedValue(new Error("db down"));
    await expect(login({}, form(TOKEN))).rejects.toThrow("NEXT_REDIRECT");
    expect(setMock).toHaveBeenCalled();
  });

  it("shares one bucket across a whole IPv6 /64", async () => {
    ipRef.value = "2001:db8:1:2:aaaa::1";
    await login({}, form("nope"));
    ipRef.value = "2001:db8:1:2:bbbb::9";
    await login({}, form("nope"));
    ipRef.value = "2001:db8:1:3::1";
    await login({}, form("nope"));
    const hashes = reserveMock.mock.calls.map((c) => c[0]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it("keeps the in-memory limiter as a secondary bound, without reserving or running PBKDF2", async () => {
    for (let i = 0; i < 5; i++) await login({}, form("nope"));
    reserveMock.mockClear();
    pbkdf2Spy.mockClear();
    const res = await login({}, form(TOKEN));
    expect(pbkdf2Spy).not.toHaveBeenCalled();
    expect(res.error).toBe("Incorrect password.");
    expect(setMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });
});
