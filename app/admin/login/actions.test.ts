import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock calls are hoisted above imports by Vitest. We fake the cookie
// store's `.set` so we can assert on exactly what attributes `logout()`
// sends — this is what regressed: `cookieStore.delete(name)` (no options)
// produces a `Set-Cookie` missing `secure`/`path`/`sameSite`, which browsers
// silently ignore when clearing a cookie originally set with `Secure`.
const setMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: setMock,
    delete: deleteMock,
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

import { logout } from "./actions";
import {
  safeLoginRedirect,
  isLoginRateLimited,
  recordFailedLogin,
  __resetLoginAttempts,
  __loginBucketCount,
} from "./login-guards";
import { SESSION_COOKIE_NAME } from "@/lib/admin-session";

describe("logout", () => {
  beforeEach(() => {
    setMock.mockClear();
    deleteMock.mockClear();
  });

  it("clears the session cookie with matching attributes instead of a bare delete", async () => {
    // A bare `.delete(name)` call reproduces the bug: Next.js's
    // ResponseCookies#delete forwards no attributes, so the resulting
    // Set-Cookie omits `secure`, letting the browser ignore it as a no-op
    // against a Secure-flagged cookie. The fix must NOT rely on `.delete()`.
    expect(deleteMock).not.toHaveBeenCalled();

    await expect(logout()).rejects.toThrow("NEXT_REDIRECT:/admin/login");

    expect(deleteMock).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledTimes(1);

    const [name, value, options] = setMock.mock.calls[0];
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(value).toBe("");
    // These must mirror login()'s cookie-set options exactly, or the browser
    // will not recognize this Set-Cookie as clearing the original cookie.
    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    // An expiry of 0 (or a maxAge of 0) is required to actually expire it.
    expect(options.maxAge === 0 || options.expires?.getTime() === 0).toBe(
      true
    );
  });
});

describe("safeLoginRedirect", () => {
  it("keeps a same-origin-relative path", () => {
    expect(safeLoginRedirect("/admin/leads")).toBe("/admin/leads");
  });

  it.each([
    ["//evil.com", "protocol-relative double slash"],
    ["/\\evil.com", "backslash-normalization bypass"],
    ["\\evil", "bare leading backslash, not a leading slash"],
    ["", "empty string"],
    ["https://evil.com", "absolute URL"],
  ])("falls back to /admin/submissions for %j (%s)", (redirectTo) => {
    expect(safeLoginRedirect(redirectTo)).toBe("/admin/submissions");
  });
});

describe("login lockout (isLoginRateLimited / recordFailedLogin)", () => {
  beforeEach(() => {
    __resetLoginAttempts();
  });

  it("is not rate-limited while under the failure cap", () => {
    const ipHash = "hash-under-cap";
    for (let i = 0; i < 4; i++) recordFailedLogin(ipHash);
    expect(isLoginRateLimited(ipHash)).toBe(false);
  });

  it("is rate-limited after 5 recorded failures within the window", () => {
    const ipHash = "hash-at-cap";
    for (let i = 0; i < 5; i++) recordFailedLogin(ipHash);
    expect(isLoginRateLimited(ipHash)).toBe(true);
  });

  it("does not rate-limit a different ipHash", () => {
    const lockedOut = "hash-locked";
    const untouched = "hash-fresh";
    for (let i = 0; i < 5; i++) recordFailedLogin(lockedOut);
    expect(isLoginRateLimited(lockedOut)).toBe(true);
    expect(isLoginRateLimited(untouched)).toBe(false);
  });

  it("__resetLoginAttempts clears all tracked bucket state", () => {
    const ipHash = "hash-to-clear";
    for (let i = 0; i < 5; i++) recordFailedLogin(ipHash);
    expect(isLoginRateLimited(ipHash)).toBe(true);

    __resetLoginAttempts();

    expect(isLoginRateLimited(ipHash)).toBe(false);
    expect(__loginBucketCount()).toBe(0);
  });

  it("never exceeds the 10_000-bucket FIFO ceiling", () => {
    for (let i = 0; i < 10_000; i++) {
      recordFailedLogin(`hash-${i}`);
    }
    expect(__loginBucketCount()).toBe(10_000);

    recordFailedLogin("hash-brand-new");
    expect(__loginBucketCount()).toBe(10_000);
  });
});
