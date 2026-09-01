"use server";

import { pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME, createSessionValue } from "@/lib/admin-session";
import { extractTrustedClientIp, hashIp } from "@/lib/rate-limit";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

const LOGIN_ATTEMPT_MAX = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Hard ceiling on distinct concurrent IP-hash buckets tracked below, mirroring
 * `lib/api-rate-limit.ts`'s FIFO-eviction guard against unbounded Map growth
 * from an attacker varying `X-Forwarded-For` across requests.
 */
const MAX_LOGIN_ATTEMPT_BUCKETS = 10_000;

interface AttemptBucket {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window in-memory cap on failed login attempts per IP hash. This is a
 * per-instance, best-effort brute-force backstop (state resets on cold
 * start, isn't shared across serverless instances) — the same caveat as
 * `lib/api-rate-limit.ts`'s read-API buckets, which this mirrors. There is
 * no admin-login-attempts table to persist this in, and adding one is out of
 * scope for this fix; the in-memory bucket is deliberately not a new
 * durable store, just this file's local instance of the existing bucket
 * idiom used elsewhere in the codebase for the same concern.
 */
const loginAttempts = new Map<string, AttemptBucket>();

export interface LoginState {
  error?: string;
}

/** True if `ipHash` is currently at or over the failed-attempt cap for the active window. */
function isLoginRateLimited(ipHash: string): boolean {
  const existing = loginAttempts.get(ipHash);
  if (!existing || Date.now() - existing.windowStart >= LOGIN_ATTEMPT_WINDOW_MS) {
    return false;
  }
  return existing.count >= LOGIN_ATTEMPT_MAX;
}

/** Records one failed attempt for `ipHash`, starting a new window if the prior one expired. */
function recordFailedLogin(ipHash: string): void {
  const now = Date.now();
  const existing = loginAttempts.get(ipHash);
  if (!existing || now - existing.windowStart >= LOGIN_ATTEMPT_WINDOW_MS) {
    if (!existing && loginAttempts.size >= MAX_LOGIN_ATTEMPT_BUCKETS) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest !== undefined) loginAttempts.delete(oldest);
    }
    loginAttempts.set(ipHash, { count: 1, windowStart: now });
    return;
  }
  existing.count++;
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

  const iterations = 210_000;
  const keylen = 32;
  const digest = "sha256";

  const presentedHash = pbkdf2Sync(password, salt, iterations, keylen, digest);
  const expectedHash = pbkdf2Sync(expected, salt, iterations, keylen, digest);
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

  // Same generic error on both the rate-limited and wrong-password paths —
  // an attacker probing the endpoint can't distinguish "locked out" from
  // "bad guess" from the response text alone.
  const ipHash = hashIp(extractTrustedClientIp(await headers()));
  if (isLoginRateLimited(ipHash)) {
    // Still run the same constant-time password check as the wrong-password
    // branch below (result discarded) so response latency doesn't leak
    // lockout state — otherwise an attacker could distinguish "locked out"
    // from "bad guess" by timing alone despite the identical error text.
    isCorrectPassword(password);
    return { error: "Incorrect password." };
  }

  if (!isCorrectPassword(password)) {
    recordFailedLogin(ipHash);
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
