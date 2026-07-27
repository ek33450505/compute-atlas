import { NextResponse } from "next/server";

import { confirmSubscription } from "@/lib/subscribe";

/**
 * Magic-link confirm target. Always redirects same-origin to a hardcoded
 * status page path — the redirect target is never derived from user input,
 * so there is no open-redirect surface here.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const { status } = await confirmSubscription(token);

  const path = status === "invalid" ? "/subscribe/invalid" : "/subscribe/confirmed";
  return NextResponse.redirect(new URL(path, request.url));
}
