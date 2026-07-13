import { createHash, timingSafeEqual } from "node:crypto";

import { jsonResponse } from "@/lib/api-response";

/** Shared 401 response — always carries CORS via `jsonResponse`. */
export function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Guards an admin write route. Returns `null` when the request is authorized,
 * or a 401 `Response` when it is not — callers do `const denied = requireAdmin(request);
 * if (denied) return denied;` before touching the DB.
 *
 * Fails CLOSED: if `API_ADMIN_TOKEN` is unset/empty, every request is
 * rejected — there is no "auth disabled" mode for write routes.
 *
 * Compares tokens by SHA-256 hashing both sides to a fixed 32-byte digest,
 * then `timingSafeEqual`. Hashing first avoids `timingSafeEqual` throwing on
 * a length mismatch (raw tokens are rarely equal length) and avoids leaking
 * the expected token's length via a throw/no-throw side channel.
 */
export function requireAdmin(request: Request): Response | null {
  const expected = process.env.API_ADMIN_TOKEN;
  if (!expected) {
    return unauthorized();
  }

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return unauthorized();
  }
  const presented = header.slice(prefix.length).trim();
  if (!presented) {
    return unauthorized();
  }

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(presentedHash, expectedHash)) {
    return unauthorized();
  }

  return null;
}
