import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { redactedErrorCode } from "@/lib/db-error";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";
import { isHoneypotTripped, recordNotifyRequestBestEffort, submitContribution } from "@/lib/contribute";

export async function POST(request: Request) {
  // Gate on PRIOR attempts, then record this one, BEFORE the body is even
  // parsed — the exact shape app/api/subscribe/route.ts uses; read that
  // handler's longer comment and `recordIntakeAttempt` (lib/rate-limit.ts)
  // for the full reasoning. Short version: this cap used to count
  // `submissions` rows, which only a successful INSERT can raise, so every
  // non-inserting path was free — `{"website":"x"}` tripped the honeypot
  // below, returned 201, wrote nothing, and cost no budget at all. A bot that
  // tripped the honeypot was completely unlimited; one that did not was capped
  // at 5/hour. Recording here, ahead of every content-dependent branch, is
  // what makes invalid JSON, a Zod failure, the honeypot, an unknown
  // targetFacilityId and a real submission all cost exactly one unit.
  //
  // Recording ahead of the branch is also required for symmetry, not just for
  // tightness: the honeypot path below returns the SAME `201 {ok:true}` as a
  // real submission, so a side effect that fired on one and not the other
  // would be observable as a difference in remaining budget.
  //
  // Three paths ahead of this point record nothing — `hashIp` throwing, the
  // gate SELECT throwing, the record INSERT throwing — and none is
  // content-dependent, so none is an oracle; all three are answered 503 below.
  // The refused (429) request deliberately does not record either, so the
  // rolling window can actually drain for a shared egress IP; that branch is
  // decided purely by the prior count and already announces itself.
  let gate: { ok: boolean };
  let ipHash: string;
  try {
    ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkIntakeRateLimit("contribute", ipHash);
    if (gate.ok) {
      await recordIntakeAttempt("contribute", ipHash);
    }
  } catch (err) {
    // Fail closed: if the attempt can't be counted or recorded, the cap can't
    // be enforced, so refuse rather than let an uncounted request through.
    // SQLSTATE only, never `err` — the sole bound param in either the gate
    // SELECT or the record INSERT is the submitter's IP hash, and
    // DrizzleQueryError's `.message` embeds bound params (lib/db-error.ts).
    console.error(
      `contribute rate-limit accounting failed — refusing the request (sqlstate: ${redactedErrorCode(err)})`
    );
    // 503, NOT 429: an outage must not hide inside ordinary rate-limiting.
    // Migrations here are applied by hand and nothing in CI applies them, so
    // shipping this before drizzle/0015 lands fails every submission closed —
    // answering that with a 429 would make a total outage indistinguishable
    // from normal traffic shaping.
    return jsonResponse(
      { error: "Submissions are temporarily unavailable. Please try again later." },
      { status: 503 }
    );
  }
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many submissions. Please try again later." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  // Honeypot: checked against the RAW body, before any schema parsing, so a
  // bot that fills `website` gets the same silent 201 with nothing written
  // regardless of whether the rest of its payload is well-formed — a bot
  // sending e.g. a bad `email` alongside a filled honeypot must never learn
  // that schema validation (not the honeypot) is what rejected it, and must
  // never reach submitContribution. Null-safe against arbitrary JSON: `body`
  // is `unknown` and may be a string, array, or null. Same silent-201
  // contract as app/api/leads/route.ts's honeypot handling.
  //
  // Deliberately NOT gated on `typeof rawWebsite === "string"` (it used to
  // be). That gate WAS the oracle this comment claims does not exist:
  // `{"website":1,"email":"bad"}` fell through to Zod and answered 400 with
  // `issues`, while `{"website":"x","email":"bad"}` answered 201 — so flipping
  // one field's TYPE told a bot both that `website` is the honeypot and that
  // its other fields were the real problem. `isHoneypotTripped` now trips on
  // any present value that is non-empty after coercion, so every type answers
  // identically.
  const rawWebsite =
    body && typeof body === "object" && "website" in body
      ? (body as { website?: unknown }).website
      : undefined;
  if (isHoneypotTripped({ website: rawWebsite })) {
    return jsonResponse({ ok: true }, { status: 201 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await submitContribution(body, ipHash, today);

  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // Scheduled to run AFTER the response is sent (security-review fix,
  // mirrors app/api/subscribe/route.ts's identical deferral of the confirm
  // email): recording the notify row inline here made response latency leak
  // whether the caller-supplied address was already at its per-address
  // notify cap (one query) vs under it (a second INSERT) — see
  // recordNotifyRequestBestEffort's doc comment in lib/contribute.ts. `notify`
  // never reaches the response body below, whether or not it's present.
  const notify = result.notify;
  if (notify) {
    after(() => recordNotifyRequestBestEffort(notify.submissionId, notify.email));
  }

  return jsonResponse({ ok: true }, { status: 201 });
}

// `public-write`: the whole point of this path is an anonymous cross-origin
// POST, so POST stays advertised. Nothing here reads a bearer token — intake is
// moderated by the `status=pending` pin, not by a credential — and the path
// exports no PATCH/DELETE, so neither belongs in its preflight.
export function OPTIONS() {
  return corsPreflight("public-write");
}
