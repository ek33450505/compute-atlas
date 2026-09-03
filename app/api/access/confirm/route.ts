import { NextResponse } from "next/server";

import { confirmAccessGrant } from "@/lib/access-grants";

/**
 * Magic-link confirm target. Always redirects same-origin to a hardcoded
 * status page path — the redirect target is never derived from user input,
 * so there is no open-redirect surface here.
 *
 * The minted `accessToken` is carried to `/access/confirmed` in a URL
 * FRAGMENT (`#token=...`), never a query param: fragments are stripped by
 * the browser before the request line is sent, so they never reach a
 * `Referer` header or get logged server-side by anything reading the
 * request URL (this route's own access log included).
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const result = await confirmAccessGrant(token);

  if (result.status === "invalid") {
    return NextResponse.redirect(new URL("/access/invalid", request.url));
  }

  return NextResponse.redirect(
    new URL(`/access/confirmed#token=${encodeURIComponent(result.accessToken)}`, request.url)
  );
}
