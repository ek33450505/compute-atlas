import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { NO_STORE_HEADERS } from "@/lib/api-response";

/**
 * Request header a Cloudflare Transform Rule injects on every request that
 * traverses the edge. Its value is compared against `EDGE_SHARED_SECRET`.
 *
 * Deliberately not prefixed `cf-`/`x-cf-`: Cloudflare reserves those names
 * and a Transform Rule cannot set them.
 */
const EDGE_SECRET_HEADER = "x-edge-shared-secret";

/** True for `/admin` and everything under it. */
function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * True for `/api/cron` and everything under it — see `isEdgeOriginAllowed`.
 *
 * Refuses any pathname containing a `%`, so this — the gate's one
 * UNCONDITIONAL exemption — can never be claimed by a path the function cannot
 * reason about. URL parsing normalizes dot-segments before we see them
 * (`/api/cron/../facilities` arrives as `/api/facilities`, measured, and pinned
 * in `proxy.test.ts`), but it does NOT decode percent-escapes:
 * `/api/cron/..%2ffacilities` keeps the `/api/cron/` prefix while naming a
 * different path. Next does not route that to `/api/facilities`, so nothing was
 * exploitable — but the exemption's safety should not rest on Next's routing
 * behaviour, and this file deliberately declines to rely on Cloudflare's
 * URL-normalization ruleset either.
 *
 * Rejecting `%` outright, rather than decoding and re-normalizing, is the
 * smaller trusted surface: decoding raises its own questions (double-encoding,
 * a malformed escape throwing out of `decodeURIComponent`, segment
 * normalization after the decode) for no gain here. A genuine Vercel Cron
 * invocation of `/api/cron/state-digest` has nothing to encode, so the only
 * thing this can refuse is a path that wanted to be something else. Refusing
 * does not block the request — it only un-exempts it, leaving it to the
 * ordinary edge check.
 */
function isCronPath(pathname: string): boolean {
  if (pathname.includes("%")) {
    return false;
  }
  return pathname === "/api/cron" || pathname.startsWith("/api/cron/");
}

/**
 * Whether the request carries proof that it arrived through our Cloudflare
 * zone rather than straight at the Vercel origin.
 *
 * ⚠️ FAILS **CLOSED** when `EDGE_SHARED_SECRET` is unset or empty, on
 * production, since 2026-10-15 — like every other gate in this repo
 * (`requireAdmin`, `verifySessionCookie` and the cron bearer). It failed OPEN
 * during the rollout, and that was deliberate:
 *
 *   The header is injected by a Cloudflare Transform Rule that is applied
 *   OUT OF BAND from this deploy, and a new Vercel env var is invisible to
 *   already-built deployments until a redeploy. A fail-closed default would
 *   have 403'd the entire site the moment the check merged — before the rule
 *   existed and before the variable was readable. Fail-open made the rollout
 *   a no-op until both halves were in place.
 *
 * Operational consequence: unsetting `EDGE_SHARED_SECRET` on production (or a
 * deploy that drops it) now 403s every matched path — `/admin`, `/api` except
 * `/api/cron/*`, `/map`, `/data`, `/table` — instead of disarming the gate.
 * Rotation therefore cannot start by unsetting it; see `docs/maintainers.md`
 * §9.
 *
 * ACTIVATION SEQUENCE — COMPLETE. Steps 1-3 were done 2026-09-27 (gate armed
 * on prod; a direct-to-origin request gets 403, one via Cloudflare gets 200);
 * steps 4-5 on 2026-10-15. Kept for the reasoning. The REDEPLOY (step 3) is
 * what ARMS the gate: the check below refuses a header-less request as soon
 * as `expected` is truthy, and a new Vercel env var is invisible to an
 * already-built deployment until a redeploy reads it. So steps 1-2 change no
 * behaviour, and the Transform Rule must already exist and be verified
 * before step 3 lands — not after it:
 *   1. Create a Cloudflare Transform Rule (Modify Request Header → Set
 *      static) injecting `x-edge-shared-secret` — EXACTLY that header name,
 *      the value of `EDGE_SECRET_HEADER` above — with the secret you are
 *      about to set, on all incoming requests. A mismatch between the rule's
 *      header name and this file 403s EVERY matched path the moment step 3
 *      lands — `/admin`, `/api` except `/api/cron/*`, `/map`, `/data` and
 *      `/table` — so copy the string, don't retype it.
 *   2. Set `EDGE_SHARED_SECRET` in the Vercel project, production scope, to
 *      that same value. Still inert — the running deployment cannot see it.
 *   3. Redeploy. This is the enforcing step. Verify with `curl --resolve
 *      www.compute-atlas.com:443:76.76.21.21 …`, which reaches Vercel without
 *      traversing Cloudflare and must now return 403, while a normal request
 *      to the same URL still returns 200.
 *   4. (done 2026-10-15) Close the remaining hole: the `if (!expected)`
 *      branch below went from `return true;` to `return false;`. This did NOT
 *      start enforcement — step 3 did — it covers the case where the variable
 *      goes ABSENT (an unset, a deploy that drops it), which used to silently
 *      reopen the bypass. ⚠️ Unsetting the variable now 403s every matched
 *      path rather than disarming the gate, which changes how rotation has to
 *      be done; see `docs/maintainers.md`.
 *   5. (done 2026-10-15) Widen the matcher to the bandwidth-heavy pages — see
 *      the `config` block at the bottom of this file for why that step was
 *      last and what was measured first.
 *
 * Why the enforcement matters: `www.compute-atlas.com` is Cloudflare-proxied,
 * but the proxied record's content is Vercel's anycast IP and Vercel routes by
 * SNI/Host — so a client that resolves the hostname to that IP itself reaches
 * the origin directly, skipping the WAF's UA blocks, the 100 GET/10s rate
 * limit, the country block, the managed DDoS ruleset and the edge cache. The
 * three heaviest pages are ~1.47 MB each and every bypassed byte is served
 * (and billed) by Vercel instead of Cloudflare's cache, so this is a bandwidth
 * and rate-limiting control.
 * Authorization is unaffected — it has always been enforced origin-side.
 *
 * Two unconditional exemptions:
 *   - **`/api/cron/*`** — Vercel Cron can invoke the deployment internally
 *     without traversing Cloudflare, so it never carries the header. Not
 *     unprotected: `app/api/cron/state-digest/route.ts` checks its own
 *     `CRON_SECRET` bearer. Breaking it would silently skip a month's mail
 *     (first scheduled state digest: 2026-10-01). Unconditional in the sense
 *     that no header value can revoke it — but `isCronPath` decides narrowly;
 *     see its comment for what it refuses to call a cron path.
 *   - **non-production `VERCEL_ENV`** — preview deployments are served from
 *     `*.vercel.app` and never traverse Cloudflare, and `VERCEL_ENV` is
 *     undefined under `next dev`/`next start`. Enforcing there would break
 *     every preview and every local run. Consequence worth knowing: a
 *     *production* deployment's own `*.vercel.app` URL does not traverse
 *     Cloudflare either, so reaching it by hand needs the header passed
 *     explicitly (`curl -H 'x-edge-shared-secret: …'`).
 *
 * Compares by SHA-256 hashing both sides to a fixed 32-byte digest, then
 * `timingSafeEqual` — the shape `lib/api-auth.ts` uses, and for the same two
 * reasons: `timingSafeEqual` throws on a length mismatch, and the throw/
 * no-throw branch would leak the expected secret's length.
 */
function isEdgeOriginAllowed(request: NextRequest, pathname: string): boolean {
  if (isCronPath(pathname)) {
    return true;
  }
  if (process.env.VERCEL_ENV !== "production") {
    return true;
  }

  const expected = process.env.EDGE_SHARED_SECRET;
  if (!expected) {
    // Fail CLOSED: an unset or empty secret must not disarm the gate.
    return false;
  }

  const presented = request.headers.get(EDGE_SECRET_HEADER);
  if (!presented) {
    return false;
  }

  const presentedHash = createHash("sha256").update(presented).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * Enforces two independent gates, in this order:
 *
 *  1. **Edge origin** (`isEdgeOriginAllowed`) — on every matched path, so a
 *     request that skipped Cloudflare is refused before anything else runs.
 *  2. **Admin session** — `/admin/*` additionally requires a valid
 *     `admin_session` cookie. `/admin/login` is intentionally allow-listed
 *     with an early return inside the function body (not carved out of the
 *     matcher) so the login page itself stays reachable while everything
 *     else under `/admin` redirects unauthenticated visitors back to it.
 *
 * The matcher covers more than `/admin/*`, so the cookie gate is guarded by
 * an explicit `/admin` prefix check — without it every matched `/api` and
 * page request would be redirected to the login screen.
 *
 * Named `proxy.ts` / `export function proxy` (not `middleware.ts`) because
 * `verifySessionCookie` needs `node:crypto` (SHA-256 + timingSafeEqual),
 * which the Edge runtime used by `middleware.ts` does not support. Next.js
 * 16 requires the Node.js runtime for this — via the `proxy` convention,
 * whose runtime is `nodejs` and is not configurable (`middleware.ts` stays
 * Edge-only and is being deprecated in favor of `proxy.ts`). See Next 16's
 * bundled upgrade guide, "`middleware` to `proxy`".
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isEdgeOriginAllowed(request, pathname)) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // A 403 is per-request, never a cacheable representation of the page.
        // Both header names, from the one shared definition. Mostly moot here:
        // reaching this response means the request skipped Cloudflare, so CF is
        // not in the path to store it. But during an activation or secret-
        // rotation mismatch CF *is* in the path and every request 403s, and a
        // 403 stored at the edge would outlive the fix that resolved the
        // mismatch.
        ...NO_STORE_HEADERS,
      },
    });
  }

  if (!isAdminPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (verifySessionCookie(cookie)) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/admin/login", request.url);
  loginUrl.searchParams.set("redirect", pathname);
  return NextResponse.redirect(loginUrl);
}

/**
 * Scope, and why each entry is here:
 *
 *  - `/admin/:path*` — the cookie gate's original scope, unchanged.
 *  - `/api/:path*` — the whole JSON surface, and low-volume. This is where
 *    losing Cloudflare's 100 GET/10s limit hurts most: the origin-side
 *    limiters are per-route and much more permissive. `/api/cron/*` matches
 *    here and is exempted in the function body, mirroring `/admin/login`.
 *
 *  - `/map`, `/table`, `/data` — exact-match literals (step 5 of the
 *    activation sequence above, 2026-10-15). They are the three measured
 *    bandwidth hogs (~1.47 MB each, shipping the facility corpus inline;
 *    together 58% of all egress), so they are exactly what this check is
 *    for. They were left out until the check enforced, because:
 *      - Proxy is step 3 of Next's documented execution order, ahead of
 *        filesystem routes (5) and dynamic routes (7), and its CDN-caching
 *        guide says proxy "should run before the CDN cache so it remains the
 *        source of truth for auth" — so a matched route pays an invocation on
 *        every request, including one that would otherwise have been a pure
 *        cache hit. On `/admin` and `/api` only, that cost is measured as
 *        small: Function Invocations were $0.06 for 2026-10-01..14
 *        (`vercel usage`). The cost on these three pages is NOT yet measured;
 *        re-measure after ship.
 *      - Whether Vercel still serves the ISR-cached BODY once proxy returns
 *        `next()` was unverified. MEASURED 2026-10-15 on a PREVIEW deployment
 *        with this widened matcher: `/map`, `/data` and `/table` were logged
 *        as `serverless-middleware` (the proxy ran) and still served
 *        `x-vercel-cache: HIT` after the first `PRERENDER`; unmatched
 *        `/about` was logged as `static`. A preview takes the non-production
 *        early return, so this proves the matcher and the cache behaviour,
 *        not the production header compare.
 *
 * Also deliberately NOT matched:
 *  - `/_next/static`, `/_next/image` and the `public/` asset prefixes
 *    (`/data/*`, `/basemap/*`, `/fonts/*`). They are served from Vercel's
 *    CDN, so a check here would add proxy latency to every asset on every
 *    page, and Next's image optimizer can fetch a local source internally
 *    without traversing Cloudflare.
 *  - the remaining ~3,000 HTML routes (`/facilities/*`, `/explore/*`, the
 *    hubs). They are ~40 KB each, not 1.47 MB — same invocation-cost
 *    argument, weaker bandwidth payoff. Not part of step 5.
 *
 * ⚠️ Matcher semantics here were MEASURED, not read, and the bundled docs are
 * wrong about them. `node_modules/next/dist/docs/…/proxy.md` says sources are
 * "anchored to the start of the path: `/about` matches `/about` and
 * `/about/team`"; compiling candidate arrays with the installed Next's
 * `getMiddlewareMatchers` shows a literal entry matches that path EXACTLY —
 * `/data` hits `/data` and NOT `/data/facilities.geojson`. That matters for
 * step 5: adding `/data` (done) will not swallow the `public/` geojson assets, which
 * would otherwise be an easy way to put the proxy in front of every tile
 * request. Also measured: `/admin/:path*` hits bare `/admin` as well as
 * `/admin/login` (hence the `pathname === "/admin"` arm in `isAdminPath`), and
 * `/api/:path*` hits `/api/cron/*` (hence the in-body exemption). `proxy.test.ts`
 * pins all of this against the real compiler; re-run it, and trust it over the
 * prose docs, whenever this list changes.
 *
 * Matcher values must be static literals to be analyzed at build time (Next
 * ignores computed ones), so this list cannot be derived from a constant.
 */
export const config = {
  matcher: ["/admin/:path*", "/api/:path*", "/map", "/data", "/table"],
};
