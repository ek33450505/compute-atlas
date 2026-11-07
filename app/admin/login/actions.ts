"use server";

import { timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionValue,
} from "@/lib/admin-session";
import { redactedErrorCode } from "@/lib/db-error";
import {
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  releaseAdminLoginAttempt,
  reserveAdminLoginAttempt,
} from "@/lib/rate-limit";
import { derivePasswordHash } from "./password-hash";
import { isLoginRateLimited, recordFailedLogin, safeLoginRedirect } from "./login-guards";

export interface LoginState {
  error?: string;
}

/** Per-process memo of the expected hash, keyed by token + salt (one PBKDF2 per request, not two). */
let expectedHashCache: { token: string; salt: string; hash: Buffer } | null = null;

function expectedHash(token: string, salt: string): Buffer {
  if (expectedHashCache?.token === token && expectedHashCache.salt === salt) {
    return expectedHashCache.hash;
  }
  const hash = derivePasswordHash(token, salt);
  expectedHashCache = { token, salt, hash };
  return hash;
}

/**
 * Verifies a submitted password against `API_ADMIN_TOKEN` using PBKDF2 and a
 * constant-time equality check. Fails closed if required env vars are unset.
 */
function isCorrectPassword(password: string): boolean {
  const expected = process.env.API_ADMIN_TOKEN;
  const salt = process.env.API_ADMIN_TOKEN_SALT;
  if (!expected || !salt) {
    return false;
  }
  if (!password) {
    return false;
  }

  const presentedHash = derivePasswordHash(password, salt);
  return timingSafeEqual(presentedHash, expectedHash(expected, salt));
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

  // Same generic error on the rate-limited and wrong-password paths, so the
  // response text does not distinguish "locked out" from "bad guess". An
  // over-budget request skips the PBKDF2 compare entirely: the resulting
  // timing difference reveals only the caller's own per-IP budget state, which
  // is not a secret, and the dummy compare only burned CPU. /64-normalised so rotating within one IPv6 prefix shares a bucket.
  const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(await headers())));
  if (isLoginRateLimited(ipHash)) {
    return { error: "Incorrect password." };
  }

  // Durable, cross-instance budget. Reserve an attempt row BEFORE the password
  // check (exact under concurrency; see `reserveAdminLoginAttempt`) and delete
  // it on success, so only failures persist. If the DB cannot answer, the cap
  // cannot be enforced, so fail closed.
  let reservation: { ok: boolean; id: string };
  try {
    reservation = await reserveAdminLoginAttempt(ipHash);
  } catch (err) {
    console.error(
      `admin login rate-limit reservation failed — refusing the attempt (sqlstate: ${redactedErrorCode(err)})`
    );
    return { error: "Login is temporarily unavailable. Try again shortly." };
  }
  if (!reservation.ok) {
    return { error: "Incorrect password." };
  }

  if (!isCorrectPassword(password)) {
    recordFailedLogin(ipHash);
    return { error: "Incorrect password." };
  }

  try {
    await releaseAdminLoginAttempt(reservation.id);
  } catch (err) {
    // The row stays and counts as a failure: conservative, never a bypass.
    console.error(`admin login reservation release failed (sqlstate: ${redactedErrorCode(err)})`);
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

  redirect(safeLoginRedirect(redirectTo));
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
