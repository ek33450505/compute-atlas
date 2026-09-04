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

/** True if `ipHash` is currently at or over the failed-attempt cap for the active window. */
export function isLoginRateLimited(ipHash: string): boolean {
  const existing = loginAttempts.get(ipHash);
  if (!existing || Date.now() - existing.windowStart >= LOGIN_ATTEMPT_WINDOW_MS) {
    return false;
  }
  return existing.count >= LOGIN_ATTEMPT_MAX;
}

/** Records one failed attempt for `ipHash`, starting a new window if the prior one expired. */
export function recordFailedLogin(ipHash: string): void {
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

/** Test-only: clears all login-attempt bucket state between test cases. */
export function __resetLoginAttempts(): void {
  loginAttempts.clear();
}

/** Test-only: current number of tracked IP-hash buckets, to verify the hard FIFO ceiling holds. */
export function __loginBucketCount(): number {
  return loginAttempts.size;
}

/**
 * Returns `redirectTo` only if it is a safe same-origin-relative path.
 * Requires a leading `/` AND a second character that is neither `/` nor `\` —
 * the `\` check closes a bypass the old `//`-only guard missed: browsers
 * normalize a leading backslash to a forward slash, so `/\evil.com` becomes
 * the same protocol-relative open redirect as `//evil.com`. Falls back to
 * `/admin/submissions` otherwise.
 */
export function safeLoginRedirect(redirectTo: string): string {
  if (redirectTo.startsWith("/") && redirectTo[1] !== "/" && redirectTo[1] !== "\\") {
    return redirectTo;
  }
  return "/admin/submissions";
}
