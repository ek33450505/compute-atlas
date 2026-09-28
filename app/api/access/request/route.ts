import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { redactedErrorCode } from "@/lib/db-error";
import { sendBulkAccessEmail } from "@/lib/email";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";
import { requestAccessGrant } from "@/lib/access-grants";

export async function POST(request: Request) {
  // Gate on PRIOR attempts, then record this one, BEFORE the body is parsed.
  // Identical shape and reasoning to app/api/contribute/route.ts — see that
  // handler's comment and `recordIntakeAttempt` (lib/rate-limit.ts).
  //
  // This endpoint is the sharpest case of the four. Its cap used to count
  // `api_access_grants` rows, and `requestAccessGrant` deliberately returns an
  // identical generic `{ok:true}` for the honeypot, the over-the-per-address
  // send cap, and an existing pending/active grant — NONE of which inserts a
  // row. So the three free paths were exactly the branches an attacker hits
  // while email-bombing one address: fill the victim's send cap, and from then
  // on every further request was both unlimited AND indistinguishable in its
  // response. Recording ahead of the branch restores the cost, and does it on
  // ALL of those paths, so the generic success stays generic.
  let gate: { ok: boolean };
  let ipHash: string;
  try {
    ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkIntakeRateLimit("access-request", ipHash);
    if (gate.ok) {
      await recordIntakeAttempt("access-request", ipHash);
    }
  } catch (err) {
    // Fail closed, SQLSTATE only (the sole bound param is the IP hash, and
    // DrizzleQueryError embeds bound params — lib/db-error.ts). 503, not 429:
    // an outage must not hide inside ordinary rate-limiting.
    console.error(
      `access-request rate-limit accounting failed — refusing the request (sqlstate: ${redactedErrorCode(err)})`
    );
    return jsonResponse(
      { error: "Access requests are temporarily unavailable. Please try again later." },
      { status: 503 }
    );
  }
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await requestAccessGrant(body, ipHash);

  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // Scheduled to run AFTER the response is sent (same timing-leak fix as
  // app/api/subscribe/route.ts, from a security review): sending inline here
  // would make response latency leak whether this email was a new request
  // (confirm set, send waits on the network) vs a duplicate/honeypot/
  // over-cap generic success (confirm unset, returns immediately). See
  // requestAccessGrant in lib/access-grants.ts for the full rationale.
  const confirm = result.confirm;
  if (confirm) {
    after(() => sendBulkAccessEmail(confirm));
  }

  return jsonResponse({ ok: true }, { status: 201 });
}

// `public-write`: anonymous POST only. The grant this creates is confirmed by a
// token mailed to the address, never by a request header, so `Authorization`
// has no caller here and the path exports no PATCH/DELETE.
export function OPTIONS() {
  return corsPreflight("public-write");
}
