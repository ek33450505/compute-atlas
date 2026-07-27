import { NextResponse } from "next/server";

import { corsPreflight } from "@/lib/api-response";
import { unsubscribeByToken } from "@/lib/subscribe";

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * Browser-navigated unsubscribe link. Redirects same-origin to a hardcoded
 * status page path — never derived from user input, so there is no
 * open-redirect surface here.
 */
export async function GET(request: Request) {
  const { status } = await unsubscribeByToken(tokenFrom(request));

  const path = status === "invalid" ? "/subscribe/invalid" : "/subscribe/unsubscribed";
  return NextResponse.redirect(new URL(path, request.url));
}

/**
 * RFC 8058 one-click unsubscribe: mail clients POST here (no redirect
 * follow) in response to the `List-Unsubscribe`/`List-Unsubscribe-Post`
 * headers set in lib/email.ts. Plain 200, no body.
 */
export async function POST(request: Request) {
  await unsubscribeByToken(tokenFrom(request));
  return new Response(null, { status: 200 });
}

export function OPTIONS() {
  return corsPreflight();
}
