import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";

/**
 * Gates every `/admin/*` route behind a valid `admin_session` cookie.
 *
 * `/admin/login` is intentionally allow-listed with an early return inside
 * the function body (not carved out of the matcher) so the login page
 * itself stays reachable while everything else under `/admin` redirects
 * unauthenticated visitors back to it.
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

export const config = {
  matcher: ["/admin/:path*"],
};
