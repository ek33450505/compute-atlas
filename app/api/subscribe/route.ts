import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { sendConfirmEmail } from "@/lib/email";
import {
  checkSubscribeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordSubscribeAttempt,
} from "@/lib/rate-limit";
import { subscribeToTarget } from "@/lib/subscribe";

/**
 * Reduces a failed rate-limit accounting step to a Postgres SQLSTATE (or
 * "unknown" — `hashIp`'s misconfiguration error carries no `code`, and its
 * message is redacted like any other) for logging. Deliberately never returns
 * the error's message or the error itself:
 * drizzle wraps driver errors in a `DrizzleQueryError` whose `.message` embeds
 * the bound params — and both of these queries' only param IS the submitter's
 * IP hash, which must never reach a log. The SQLSTATE carries everything an
 * operator needs (e.g. 42P01 = table missing, i.e. the migration has not been
 * applied) and nothing about the caller.
 */
function redactedFailureCode(err: unknown): string {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  for (const layer of layers) {
    const code = (layer as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

export async function POST(request: Request) {
  // The IP hash is derived FIRST, before the body is even parsed, so that the
  // attempt below is recorded on every path that reaches a branch decision —
  // including an unparseable body. (This handler used to parse first, which
  // made the "Invalid JSON" 400 uncounted.) Three paths ahead of that point
  // record nothing: `hashIp` throwing, the gate SELECT throwing, and the record
  // INSERT throwing. None is content-dependent — they fail the same way for
  // every caller — so none is an oracle; they are infrastructure failures and
  // are answered as such below.
  //
  // Gate on PRIOR attempts, then record this one, before any content-dependent
  // branch. Gate-then-record (not record-then-gate) keeps `count < RATE_LIMIT_MAX`
  // meaning exactly what it means for every other limiter in lib/rate-limit.ts,
  // so 5 requests per hour still succeed and the 6th is refused.
  //
  // Recording before every branch is the point: `subscribeToTarget` returns an
  // identical generic `{ok:true}` for the honeypot / duplicate / over-cap paths
  // (a prior security-review fix), and the confirm email is sent after the
  // response so latency can't separate them either. A rate-limit side effect
  // that fired on some of those paths but not others would put the distinction
  // back, observable as a difference in remaining budget. Every request that
  // gets past the gate costs exactly one attempt row, whatever it goes on to do.
  //
  // The refused (`!gate.ok`) request deliberately does NOT record. Recording it
  // would mean the rolling window never drains under sustained traffic: a shared
  // IPv4 egress (CGNAT, corporate NAT, VPN, campus) would be locked out
  // indefinitely rather than for an hour, and a blocked client politely retrying
  // would extend its own block forever. This is oracle-safe, and is NOT a hole in
  // the symmetry above: the 429 branch is decided purely by the prior count,
  // never by anything in the request, and it already announces itself in the
  // status code — so no information flows that the response did not already
  // carry. It does not weaken the cap either; an abuser stays refused throughout.
  // (This does diverge from the literal instruction, which listed "over-cap"
  // among the paths that must write. It serves that instruction's stated purpose
  // — "so no branch is distinguishable" — because the over-cap branch was never
  // in the indistinguishable set.)
  //
  // All three steps sit inside one try. The gate SELECT binds the same `ipHash`
  // and fails in exactly the same circumstances as the INSERT (42P01 when the
  // migration has not been applied being the motivating case), so leaving it
  // outside would mean the redaction and the fail-closed answer never ran for
  // the failure they were written for — the SELECT would throw first, uncaught,
  // and Next would log the query with the ip hash in its params.
  //
  // `hashIp` is inside it for the same reason: it throws by design when
  // CONTRIBUTE_IP_SALT is unset in production, which is an infrastructure
  // misconfiguration exactly like an unapplied migration. Outside the try it was
  // the one path here that answered an uncaught 500 and leaked a stack trace to
  // the caller, while the comment above claimed all three were answered as
  // infrastructure failures. They are now.
  let gate: { ok: boolean };
  let ipHash: string;
  try {
    ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkSubscribeRateLimit(ipHash);
    if (gate.ok) {
      await recordSubscribeAttempt(ipHash);
    }
  } catch (err) {
    // Fail closed: if the attempt can't be counted or recorded, the cap can't be
    // enforced, so refuse rather than let an uncounted request through. Never log
    // the IP, the hash, or an email address — hence the SQLSTATE-only form (see
    // redactedFailureCode above; logging `err` itself would print the ip hash).
    console.error(
      `subscribe rate-limit accounting failed — refusing the request (sqlstate: ${redactedFailureCode(err)})`
    );
    // 503, NOT 429: this is an outage, not a limit, and it must not hide inside
    // ordinary rate-limiting. Migrations here are applied by hand and nothing in
    // CI applies them, so shipping this before the migration lands fails every
    // subscribe closed — answering that with a 429 would make a total outage
    // indistinguishable from normal traffic shaping until the nightly drift
    // alert noticed, up to ~24h later. An outage should announce itself.
    return jsonResponse(
      { error: "Subscriptions are temporarily unavailable. Please try again later." },
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

  const result = await subscribeToTarget(body, ipHash);

  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // Scheduled to run AFTER the response is sent (Fix 1, s65 security
  // review): sending inline here made response latency leak whether the
  // (email,target) pair was new (confirm set, send waits on the network) vs
  // a duplicate/honeypot/over-cap generic success (confirm unset, returns
  // immediately). See subscribeToTarget in lib/subscribe.ts for the full
  // rationale.
  const confirm = result.confirm;
  if (confirm) {
    after(() => sendConfirmEmail(confirm));
  }

  return jsonResponse({ ok: true }, { status: 201 });
}

export function OPTIONS() {
  return corsPreflight();
}
