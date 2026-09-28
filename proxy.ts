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
 * ⚠️ FAILS **OPEN** ON PURPOSE when `EDGE_SHARED_SECRET` is unset or empty.
 * This is the opposite of every other gate in this repo (`requireAdmin`,
 * `verifySessionCookie` and the cron bearer all fail CLOSED) — do not
 * "fix" it without reading this paragraph:
 *
 *   The header is injected by a Cloudflare Transform Rule that is applied
 *   OUT OF BAND from this deploy, and a new Vercel env var is invisible to
 *   already-built deployments until a redeploy. A fail-closed default would
 *   therefore 403 the entire site the moment this merges — before the rule
 *   exists and before the variable is readable. Fail-open makes the rollout
 *   a no-op until both halves are in place, and the check starts enforcing
 *   the moment the variable appears.
 *
 * ACTIVATION SEQUENCE — five steps, in this order. Steps 1-3 change no
 * behaviour at all (the check is still failing open); step 4 is the one that
 * starts enforcing:
 *   1. Set `EDGE_SHARED_SECRET` in the Vercel project, production scope.
 *   2. Create a Cloudflare Transform Rule (Modify Request Header → Set
 *      static) injecting `x-edge-shared-secret` — EXACTLY that header name,
 *      the value of `EDGE_SECRET_HEADER` above — with that same secret, on
 *      all incoming requests. A mismatch between the rule's header name and
 *      this file is a site-wide 403 the moment step 4 lands, so copy the
 *      string, don't retype it.
 *   3. Redeploy. A new Vercel env var is invisible to already-built
 *      deployments, so until this step the running function reads `undefined`
 *      and keeps failing open no matter what the rule does.
 *   4. Make it fail CLOSED: replace the `if (!expected) return true;` below
 *      with `return false;`. Verify with `curl --resolve
 *      www.compute-atlas.com:443:76.76.21.21 …`, which reaches Vercel without
 *      traversing Cloudflare and must now return 403, while a normal request
 *      to the same URL still returns 200.
 *   5. Only then widen the matcher to the bandwidth-heavy pages — see the
 *      `config` block at the bottom of this file for why that step is last.
 *
 * Why the enforcement matters: `www.compute-atlas.com` is Cloudflare-proxied,
 * but the proxied record's content is Vercel's anycast IP and Vercel routes by
 * SNI/Host — so a client that resolves the hostname to that IP itself reaches
 * the origin directly, skipping the WAF's UA blocks, the 100 GET/10s rate
 * limit, the country block, the managed DDoS ruleset and the edge cache. The
 * three heaviest pages are ~1.47 MB each and the project sits near the 100 GB
 * Vercel bandwidth cap, so this is a bandwidth and rate-limiting control.
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
    return true; // ⚠️ fail-open — see the doc comment above before changing
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
 * ⚠️ `/map`, `/table`, `/data` are NOT matched yet, and that is the whole of
 * step 5 of the activation sequence above. They are the three measured
 * bandwidth hogs (~1.47 MB each, shipping the facility corpus inline;
 * together 58% of all egress), so they are exactly what this check is
 * ultimately for — but matching them BEFORE the check enforces buys nothing
 * and costs per-request function invocations on the site's busiest routes:
 *   - Proxy is step 3 of Next's documented execution order, ahead of
 *     filesystem routes (5) and dynamic routes (7), and its CDN-caching guide
 *     says proxy "should run before the CDN cache so it remains the source of
 *     truth for auth" — so a matched route pays an invocation on every
 *     request, including one that would otherwise have been a pure cache hit.
 *     This project is at its Vercel Hobby limits.
 *   - ⛔ UNVERIFIED: whether Vercel still serves the ISR-cached BODY after
 *     this returns `next()`, or re-renders the page. Next's guide allows for a
 *     deployment that puts proxy behind the CDN and tells you to bypass
 *     caching for those routes, which would be the bad direction. Measure a
 *     `cache` HIT on `/map` on a preview before doing step 5.
 * While the check fails open those invocations would buy no protection at
 * all, which is why this is ordered last rather than shipped together.
 *
 * Also deliberately NOT matched:
 *  - `/_next/static`, `/_next/image` and the `public/` asset prefixes
 *    (`/data/*`, `/basemap/*`, `/fonts/*`). They are served from Vercel's
 *    CDN, so a check here would add proxy latency to every asset on every
 *    page, and Next's image optimizer can fetch a local source internally
 *    without traversing Cloudflare.
 *  - the remaining ~3,000 HTML routes (`/facilities/*`, `/explore/*`, the
 *    hubs). They are ~40 KB each, not 1.47 MB — same invocation-cost
 *    argument, weaker bandwidth payoff. After step 5, not with it.
 *
 * ⚠️ Matcher semantics here were MEASURED, not read, and the bundled docs are
 * wrong about them. `node_modules/next/dist/docs/…/proxy.md` says sources are
 * "anchored to the start of the path: `/about` matches `/about` and
 * `/about/team`"; compiling candidate arrays with the installed Next's
 * `getMiddlewareMatchers` shows a literal entry matches that path EXACTLY —
 * `/data` hits `/data` and NOT `/data/facilities.geojson`. That matters for
 * step 5: adding `/data` will not swallow the `public/` geojson assets, which
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
  matcher: ["/admin/:path*", "/api/:path*"],
};
