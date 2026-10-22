import { NextResponse } from "next/server";

import { checkApiRateLimit, tooManyRequests } from "@/lib/api-rate-limit";
import { corsPreflight, NO_STORE_HEADERS } from "@/lib/api-response";
import { redactedErrorCode } from "@/lib/db-error";
import { extractTrustedClientIp } from "@/lib/rate-limit";
import {
  resumeByToken,
  stopAllStateByToken,
  undoStopAllByToken,
  unsubscribeAllByToken,
  unsubscribeByToken,
} from "@/lib/subscribe";

/**
 * Prefix for this route's own `checkApiRateLimit` buckets — separate from the
 * public read API's bare-IP keys and from the sibling token routes, so a burst
 * against one surface cannot starve another (same reasoning as
 * `checkIntakeRateLimit("contact")` vs `("leads")` in lib/rate-limit.ts, whose
 * separation is the `surface` predicate on every read). GET
 * and POST share this prefix: they are one surface doing one thing, and the
 * work they cost is identical.
 */
const RATE_BUCKET_PREFIX = "sub-unsub:";

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get("token") ?? "";
}

/**
 * The two extra actions share this route, selected by query param:
 * `scope=all` ("stop all email") and `action=resume`. Both mutate ONLY on POST;
 * a GET for either just lands on a confirmation page, because mail scanners
 * prefetch every link in a message.
 */
function isStopAll(request: Request): boolean {
  return new URL(request.url).searchParams.get("scope") === "all";
}

function isUndo(request: Request): boolean {
  return isStopAll(request) && new URL(request.url).searchParams.get("action") === "undo";
}

function isResume(request: Request): boolean {
  return new URL(request.url).searchParams.get("action") === "resume";
}

/** A slow or stalled body is not a one-click: give up reading after this long. */
const ONE_CLICK_READ_TIMEOUT_MS = 2000;

/** RFC 8058: the entire body a one-click client sends. */
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/**
 * True iff the POST body is exactly the RFC 8058 one-click marker. Reads at
 * most a few bytes past the marker's length and never throws: anything longer,
 * unreadable or different is simply "not one-click" (a page form posts an
 * empty body).
 */
async function isOneClick(request: Request): Promise<boolean> {
  const limit = ONE_CLICK_BODY.length + 1;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > ONE_CLICK_BODY.length) {
    return false;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return false;
  }
  const read = async (): Promise<boolean> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total > ONE_CLICK_BODY.length) {
      return false;
    }
    return new TextDecoder().decode(Buffer.concat(chunks)) === ONE_CLICK_BODY;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A stalled body (slowloris) must not hold the handler: after the timeout
    // it is simply not a one-click.
    return await Promise.race([
      read(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ONE_CLICK_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

/** 303 after a browser form POST; hardcoded paths, never derived from input. */
function seeOther(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), {
    status: 303,
    headers: NO_STORE_HEADERS,
  });
}

/**
 * Browser-navigated unsubscribe link. NEVER mutates: mail scanners prefetch
 * every link in a message, and an opt-out is now durable, so a GET only
 * redirects to a confirmation page whose POST button does the work. Redirects
 * same-origin to hardcoded paths, never derived from user input, so there is
 * no open-redirect surface here.
 *
 * UNCACHEABLE (measured on prod 2026-09-27): a Cloudflare cache rule makes
 * every non-`/admin` GET cache-eligible, and with no origin directive
 * Cloudflare supplied `public, max-age=14400` — caching an unsubscribe token
 * in a cache key for 4 hours.
 *
 * RATE LIMITED with the in-memory burst limiter, deliberately not a DB-backed
 * one: the POST costs a Neon SELECT plus writes per call.
 */
export async function GET(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  const token = tokenFrom(request);
  if (!token) {
    return NextResponse.redirect(new URL("/subscribe/invalid", request.url), { headers: NO_STORE_HEADERS });
  }
  let path = `/subscribe/unsubscribe?token=${encodeURIComponent(token)}`;
  if (isStopAll(request)) {
    // Reopening the stop-all link is a READ (never a write): if all email is
    // already stopped, send the holder of the token that did it to the page
    // with Undo; anyone else to the "already stopped" page; otherwise to the
    // confirm page. An unknown token and "not stopped" look identical, so
    // this reveals nothing about token validity. On a lookup error fall back
    // to the confirm page, whose own POST re-checks.
    const state = await stopAllStateByToken(token);
    path =
      state === "stopped_by_this"
        ? `/subscribe/stopped-all?token=${encodeURIComponent(token)}`
        : state === "stopped_by_other"
          ? "/subscribe/stopped-all?state=other"
          : `/subscribe/stop-all?token=${encodeURIComponent(token)}`;
  }
  return NextResponse.redirect(new URL(path, request.url), { headers: NO_STORE_HEADERS });
}

/**
 * Two kinds of POST share this handler.
 *
 * RFC 8058 one-click (body exactly `List-Unsubscribe=One-Click`, sent by mail
 * clients in response to the `List-Unsubscribe-Post` header): performs the
 * per-target unsubscribe, or the global one with `scope=all`, and answers a
 * plain 200 with no body, because a client does not follow redirects. A DB
 * failure is a 503 so the client retries.
 *
 * Page forms (any other body): `scope=all` (stop all email), `scope=all&action=undo`
 * (lift that stop-all, only for the token that wrote it), `action=resume`,
 * or the plain unsubscribe; each answers a 303 to a hardcoded status page. A
 * DB failure redirects to /subscribe/invalid.
 *
 * Every response carries `no-store`: it is per-token and must never be stored
 * by anything, including an intermediary that ignores method.
 */
export async function POST(request: Request) {
  const rate = checkApiRateLimit(RATE_BUCKET_PREFIX + extractTrustedClientIp(request.headers));
  if (!rate.ok) {
    return tooManyRequests(rate.retryAfter);
  }

  // "Undo stop-all" is only ever a page form; a one-click body never reaches it.
  const undo = isUndo(request);
  const oneClick = !undo && (await isOneClick(request));
  const token = tokenFrom(request);
  try {
    if (oneClick) {
      if (isStopAll(request)) {
        await unsubscribeAllByToken(token);
      } else {
        await unsubscribeByToken(token);
      }
      return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
    }

    if (undo) {
      const { status } = await undoStopAllByToken(token);
      return seeOther(request, status === "invalid" ? "/subscribe/invalid" : "/subscribe/undone");
    }
    if (isStopAll(request)) {
      const { status, undoable } = await unsubscribeAllByToken(token);
      return seeOther(
        request,
        status === "invalid"
          ? "/subscribe/invalid"
          : undoable
            ? `/subscribe/stopped-all?token=${encodeURIComponent(token)}`
            : "/subscribe/stopped-all?state=other"
      );
    }
    if (isResume(request)) {
      const { status } = await resumeByToken(token);
      const path = {
        invalid: "/subscribe/invalid",
        resumed: "/subscribe/resumed",
        already_active: "/subscribe/resumed?state=active",
        still_stopped: "/subscribe/resumed?state=stopped",
        lift_failed: `/subscribe/resumed?state=retry&token=${encodeURIComponent(token)}`,
      }[status];
      return seeOther(request, path);
    }
    const { status } = await unsubscribeByToken(token);
    return seeOther(
      request,
      status === "invalid"
        ? "/subscribe/invalid"
        : `/subscribe/unsubscribed?token=${encodeURIComponent(token)}`
    );
  } catch (err) {
    // The thrown error can embed the address (Drizzle); log the SQLSTATE only.
    console.error(`unsubscribe route failed (sqlstate: ${redactedErrorCode(err)})`);
    if (oneClick) {
      return new Response(null, { status: 503, headers: NO_STORE_HEADERS });
    }
    return seeOther(request, "/subscribe/invalid");
  }
}

// `public-write`: GET and POST, both authorised by a token in the URL rather
// than a header — so `Authorization` is advertised to nobody, and there is no
// PATCH/DELETE to advertise either.
export function OPTIONS() {
  return corsPreflight("public-write");
}
