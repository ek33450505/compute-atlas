import { createHash, timingSafeEqual } from "node:crypto";

import { jsonResponse } from "@/lib/api-response";

/** Shared 401 response — always carries CORS via `jsonResponse`. */
export function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Constant-time `Authorization: Bearer <token>` check against one expected
 * secret. Returns `false` — never throws — for every failure mode, so callers
 * can compose several expected tokens without branching on why one missed.
 *
 * Fails CLOSED when `expected` is unset/empty: an unconfigured secret matches
 * nothing, so there is no "auth disabled" mode.
 *
 * Compares tokens by SHA-256 hashing both sides to a fixed 32-byte digest,
 * then `timingSafeEqual`. Hashing first avoids `timingSafeEqual` throwing on
 * a length mismatch (raw tokens are rarely equal length) and avoids leaking
 * the expected token's length via a throw/no-throw side channel.
 */
function bearerMatches(request: Request, expected: string | undefined): boolean {
  if (!expected) {
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  const presented = header.slice(prefix.length).trim();
  if (!presented) {
    return false;
  }

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Guards an admin write route. Returns `null` when the request is authorized,
 * or a 401 `Response` when it is not — callers do `const denied = requireAdmin(request);
 * if (denied) return denied;` before touching the DB.
 *
 * `API_ADMIN_TOKEN` is the FULL-PRIVILEGE secret: create/patch/delete of live
 * facilities, approve/reject of any pending submission, and (via
 * `lib/admin-session.ts`) the HMAC key for the admin session cookie. Routes
 * that only need to STAGE unreviewed data must use `requireIntake` instead,
 * so a copy of the staging credential cannot be replayed against any of the
 * above.
 *
 * Fails CLOSED: if `API_ADMIN_TOKEN` is unset/empty, every request is
 * rejected — there is no "auth disabled" mode for write routes.
 */
export function requireAdmin(request: Request): Response | null {
  return bearerMatches(request, process.env.API_ADMIN_TOKEN) ? null : unauthorized();
}

/**
 * Guards the staging-only intake route (`POST /api/submissions`). Accepts
 * EITHER `API_INTAKE_TOKEN` or `API_ADMIN_TOKEN`; same return contract as
 * `requireAdmin`.
 *
 * Why two accepted tokens, and why only here:
 * - The nightly discovery pipeline needs exactly one capability — stage a
 *   `pending` row. `API_INTAKE_TOKEN` grants that and nothing else, so a
 *   leaked copy cannot publish a live facility, approve its own submission,
 *   or forge an admin session cookie. The core invariant (no unreviewed write
 *   becomes a live facility) stops being a one-secret gate.
 * - `API_ADMIN_TOKEN` is still accepted so the admin UI and the `submissions`
 *   CLI keep working unchanged, and so the pipeline keeps running on the admin
 *   token while `API_INTAKE_TOKEN` is unset in production. The separation
 *   only takes effect once `API_INTAKE_TOKEN` is set AND the pipeline's copy
 *   of `API_ADMIN_TOKEN` is removed — until then this is an additive,
 *   backwards-compatible no-op.
 *
 * ⚠️ Setting `API_INTAKE_TOKEN` to the same value as `API_ADMIN_TOKEN` gives
 * no separation at all: the intake secret would then also be the live-write
 * and cookie-signing secret. Generate an independent value.
 *
 * Fails CLOSED: with both vars unset/empty, every request is rejected.
 */
export function requireIntake(request: Request): Response | null {
  if (bearerMatches(request, process.env.API_INTAKE_TOKEN)) {
    return null;
  }
  return requireAdmin(request);
}
