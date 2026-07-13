"use server";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, createSessionValue } from "@/lib/admin-session";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface LoginState {
  error?: string;
}

/**
 * Verifies a submitted password against `API_ADMIN_TOKEN` using the same
 * hash+timingSafeEqual idiom as `lib/api-auth.ts`'s `requireAdmin`. Fails
 * closed if the env var is unset.
 */
function isCorrectPassword(password: string): boolean {
  const expected = process.env.API_ADMIN_TOKEN;
  if (!expected) {
    return false;
  }
  if (!password) {
    return false;
  }

  const presentedHash = createHash("sha256").update(password).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Server Action backing the admin login form. On success, sets the
 * `admin_session` cookie and redirects to the `redirect` query param (if
 * present and same-origin-relative) or `/admin/submissions`. On failure,
 * returns a form error — no cookie is set, no redirect happens.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const redirectTo = String(formData.get("redirect") ?? "");

  if (!isCorrectPassword(password)) {
    return { error: "Incorrect password." };
  }

  const expected = process.env.API_ADMIN_TOKEN;
  if (!expected) {
    // Unreachable given isCorrectPassword's fail-closed check above, but
    // keeps this function's own control flow fail-closed too.
    return { error: "Incorrect password." };
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, createSessionValue(expected), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  const destination =
    redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")
      ? redirectTo
      : "/admin/submissions";
  redirect(destination);
}

/**
 * Clears the admin session cookie and returns the user to the login page.
 *
 * `cookieStore.delete(name)` alone is NOT enough here: internally it calls
 * `.set({ name, value: "", expires: new Date(0) })` with no other
 * attributes, so the resulting `Set-Cookie` omits `secure`/`path`/`sameSite`.
 * A non-`Secure` clear for a name the browser holds as `Secure` is silently
 * dropped, so the original cookie survives. Passing the same attributes
 * `login()` used to set it (`httpOnly`, `secure`, `sameSite`, `path`) plus
 * `maxAge: 0` ensures the browser recognizes this as an update to the same
 * cookie and actually clears it.
 */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  redirect("/admin/login");
}
