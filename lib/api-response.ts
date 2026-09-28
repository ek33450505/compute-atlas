import { NextResponse } from "next/server";
import { DATASET_LICENSE_URL } from "@/lib/site";

/**
 * Permissive CORS for the public API. `*` origin stays safe here: writes
 * authenticate via an `Authorization: Bearer` header, never cookies, and `*`
 * with no `Access-Control-Allow-Credentials` forbids credentialed requests —
 * so browsers withhold cookies and never auto-attach a bearer token
 * cross-origin, leaving no CSRF / ambient-credential path. That reasoning is
 * unchanged and is *why* `*` is still correct.
 *
 * What changed on 2026-09-27 is breadth, not the origin. A single set was
 * spread everywhere, so `GET /api/facilities` — anonymous, public, read-only —
 * answered every origin with `Access-Control-Allow-Methods: GET, POST, PATCH,
 * DELETE, OPTIONS` and `Access-Control-Allow-Headers: Content-Type,
 * Authorization`. Not a credential hole, but it let a hostile page preflight
 * and then drive unauthenticated cross-origin writes against a read endpoint
 * and read the resulting error, which is broader than any caller needs.
 *
 * The scopes are keyed on a path's **auth posture** — who may call it and with
 * what credential — deliberately NOT on its exact verb list. A verb list here
 * would be a second copy of each route's own `export function` table, free to
 * drift silently the day a route gains a method; posture is a property the
 * route cannot change without a reviewer noticing.
 *
 * - `read` — anonymous, read-only. No write verb, no `Authorization`.
 * - `public-write` — anonymous, unauthenticated write (moderated intake and
 *   the token-in-URL subscribe surfaces). POST advertised, `Authorization` not.
 *   GET rides along because it is CORS-simple: a plain cross-origin GET is
 *   sent with or without this list, so omitting it would buy nothing.
 * - `admin` — bearer-authenticated, may write. The pre-split value.
 *
 * These scopes are for **preflights only**. Per the Fetch standard the two
 * lists are consulted during a CORS-preflight fetch and nowhere else; a
 * non-preflight response's CORS check reads `Access-Control-Allow-Origin`
 * alone. So an actual response must not carry them at all — see
 * `CORS_RESPONSE_HEADERS`.
 */
export type CorsScope = "read" | "public-write" | "admin";

export const CORS_HEADERS_BY_SCOPE = {
  read: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  },
  "public-write": {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  },
  admin: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  },
} as const satisfies Record<CorsScope, Record<string, string>>;

/**
 * CORS headers for an **actual response** — the only one that does anything.
 * `Access-Control-Allow-Methods` / `-Allow-Headers` are consulted during a
 * CORS-preflight fetch and nowhere else, so emitting them on a 200 or an error
 * body neither permits nor forbids a verb; it only publishes a claim about the
 * path. Before 2026-09-27 every response published the widest claim there was,
 * which is how the finding was measured: `GET /api/facilities` advertised four
 * write verbs and `Authorization` to `https://evil.example`. Dropping the pair
 * is strictly better than narrowing it — a `read`-scoped response would still
 * have been a claim, and on a path like `/api/submissions` a false one.
 *
 * ⚠️ No `Vary: Origin` here or on the scopes above, and that is the correct
 * answer rather than an omission. `Vary` names the request headers a response's
 * *content* depends on; this value is a literal `*`, computed from nothing, so
 * the response does not vary by `Origin` and declaring that it does would be
 * false. It would also hand any caller a free cache-fragmentation lever on
 * endpoints running `s-maxage` up to 604800.
 *
 * `Vary: Origin` becomes **mandatory** the moment `Access-Control-Allow-Origin`
 * is derived from the request — a reflected origin, or an allowlist of specific
 * origins — because a shared cache would otherwise serve one origin's grant to
 * another. If you are here to make that change, add it.
 * `lib/api-response.test.ts` pins the literal `*` so that day fails loudly here
 * instead of quietly at the edge.
 */
export const CORS_RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
} as const;

/**
 * `no-store` under **both** header names, because Cloudflare evaluates
 * `CDN-Cache-Control` ahead of `Cache-Control` — a bare `no-store` must block
 * storage in either Origin-Cache-Control mode.
 *
 * There is exactly **one** definition of this pair — do not fork a private
 * copy. Three existed before 2026-09-27: the two subscribe token routes and
 * `/api/access/confirm` each declared their own, because they return redirects
 * rather than JSON and so cannot go through `jsonResponse`. They now import
 * this, as does `proxy.ts`'s 403, so the pair cannot drift.
 * `lib/api-response.test.ts` scans the source tree for a re-fork.
 */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "CDN-Cache-Control": "no-store",
} as const;

/**
 * JSON response helper that always carries the shared CORS headers, and is
 * **`no-store` by default** — see `cacheableJson` for the opt-in cacheable path.
 *
 * This helper serves bearer-gated bodies (`GET /api/submissions` returns every
 * staged row), write results, error bodies and 429s. An authenticated response
 * must never be stored in a shared cache: RFC 9111 §3.5 forbids it, but
 * Cloudflare treats `public` / `s-maxage` / `must-revalidate` as a waiver of
 * that rule, and Next's dynamic-route default (`public, max-age=0,
 * must-revalidate`) carries two of the three. With a Cloudflare cache rule
 * making every non-`/admin` GET cache-eligible, that default left
 * `GET /api/submissions` storable at the edge — disclosure was prevented only
 * by `max-age=0` and the absence of an `ETag`/`Last-Modified` forcing every
 * revalidation to be an unauthenticated (401ing) GET. One TTL-mode change in
 * the Cloudflare dashboard would have turned that into a real leak.
 *
 * Both header names come from the shared `NO_STORE_HEADERS` above — see there
 * for why the pair, and why it lives in one place. Both sit *before* the
 * `init.headers` spread, so a caller that deliberately supplies its own
 * `Cache-Control` still wins.
 *
 * Carries `CORS_RESPONSE_HEADERS` — the origin and nothing else. This helper
 * serves every kind of body there is (a bearer-gated read, a write result, a
 * 400, a 429), so no single preflight scope could describe it honestly; and
 * since the preflight-only pair does nothing on an actual response, the honest
 * choice is to publish no verb claim at all. The verb a caller may use is
 * decided by that path's `OPTIONS` — see `corsPreflight`.
 */
export function jsonResponse(
  data: unknown,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...CORS_RESPONSE_HEADERS,
      ...NO_STORE_HEADERS,
      ...init?.headers,
    },
  });
}

/**
 * Shared OPTIONS preflight response — each route re-exports this as its own
 * `OPTIONS`, naming the scope its path genuinely accepts.
 *
 * ⚠️ One `OPTIONS` answers for a whole path, so a **mixed** path (public GET
 * plus a bearer-gated write, e.g. `/api/facilities`) must advertise the union
 * of what it accepts and therefore stays on `admin`. Narrowing such a path to
 * `read` would 405 a legitimate cross-origin bearer client at the preflight —
 * a real break traded for a cosmetically narrower header. Don't.
 *
 * `scope` is **required, and there is deliberately no default** — that is the
 * safety property this signature exists for: a route that forgets the scope
 * does not compile. Every possible default is wrong in one direction and silent
 * in both. `admin` over-advertises a read endpoint, which *is* the 2026-09-27
 * finding; `read` blocks a legitimate cross-origin write at the preflight
 * (`POST /api/contribute` and `POST /api/leads` are published as
 * browser-callable in `app/api/page.tsx`, and a JSON POST is not CORS-simple,
 * so it is preflighted). Neither failure surfaces at runtime. A required
 * argument turns "nobody decided this path's posture" into a type error.
 *
 * A transitional `admin` default did exist while five call sites were off-limits
 * to the split; it was load-bearing then and is not now that every route names
 * its own scope.
 *
 * The type system can only catch an *absent* scope, never a *wrong* one, so
 * `lib/api-response.test.ts` keeps `EXPECTED_ROUTE_SCOPES` — an exact
 * route→scope map asserted in both directions — as the second layer. It also
 * pins `corsPreflight.length`, because re-adding a default parameter would
 * silently undo the property above and break nothing else.
 */
export function corsPreflight(scope: CorsScope): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS_BY_SCOPE[scope] });
}

/** Bumped only on a breaking response-shape change to a public read endpoint. */
export const API_VERSION = "1";

/** CDN cache lifetime + stale-while-revalidate window, in seconds, for `cacheableJson`. */
export interface ReadCacheWindow {
  sMaxage: number;
  swr: number;
}

/** Per-endpoint cache tunables, one entry per public read GET. */
export const READ_CACHE = {
  list: { sMaxage: 3600, swr: 86400 },
  stats: { sMaxage: 3600, swr: 86400 },
  schema: { sMaxage: 86400, swr: 604800 },
  search: { sMaxage: 600, swr: 3600 },
  facility: { sMaxage: 3600, swr: 86400 },
} satisfies Record<string, ReadCacheWindow>;

/**
 * JSON response helper for cacheable public read endpoints: carries the
 * shared CORS headers plus a CDN-facing `Cache-Control`, the CC-BY-4.0 data
 * license/attribution headers, and the API version. Writes, error bodies, and
 * 429s stay on plain `jsonResponse` — never cached, and that is *enforced* by
 * its `no-store` default rather than left to each caller. The rate limiter's
 * 429 (`tooManyRequests`, `lib/api-rate-limit.ts`) is included in that only
 * because it now routes through `jsonResponse`; until 2026-09-27 it built its
 * own `NextResponse` and set no cache directive at all, so Cloudflare supplied
 * `public, max-age=14400` and a single caller's 429 was servable to everyone
 * else on that URL. Caching here is opt-in: reaching the edge requires choosing
 * this helper and naming a `READ_CACHE` window.
 *
 * Builds its response with `NextResponse.json` directly, not via
 * `jsonResponse`, so the `no-store` default cannot reach a public read. No
 * `CDN-Cache-Control` is set: with it absent Cloudflare falls back to this
 * `Cache-Control`, which is the intended shared-cache directive.
 *
 * Carries `CORS_RESPONSE_HEADERS`, same as `jsonResponse` — the origin alone.
 * This is the helper the finding was measured against: `GET /api/facilities`
 * builds its 200 here, so this is where the wide verb/header pair stops being
 * served to every origin, including on the two mixed paths whose *preflight*
 * must stay `admin`.
 */
export function cacheableJson(
  data: unknown,
  cache: ReadCacheWindow,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...CORS_RESPONSE_HEADERS,
      "Cache-Control": `public, s-maxage=${cache.sMaxage}, stale-while-revalidate=${cache.swr}`,
      "X-License": "CC-BY-4.0",
      Link: `<${DATASET_LICENSE_URL}>; rel="license"`,
      "X-API-Version": API_VERSION,
      ...init?.headers,
    },
  });
}
