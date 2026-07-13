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
