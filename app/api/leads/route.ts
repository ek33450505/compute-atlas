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
import { isHoneypotTripped } from "@/lib/contribute";
import { createLead, setLeadTriage } from "@/lib/leads";
import { triageUrl } from "@/lib/url-triage";
import { findFacilitiesCitingUrl } from "@/lib/lead-dedupe";

export async function POST(request: Request) {
  // Gate on PRIOR attempts, then record this one, BEFORE the body is parsed.
  // Identical shape and reasoning to app/api/contribute/route.ts — see that
  // handler's comment and `recordIntakeAttempt` (lib/rate-limit.ts). This cap
  // used to count `leads` rows, which only a successful INSERT can raise, so
  // the honeypot and Zod-failure paths cost nothing.
  let gate: { ok: boolean };
  let ipHash: string;
  try {
    ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkIntakeRateLimit("leads", ipHash);
    if (gate.ok) {
      await recordIntakeAttempt("leads", ipHash);
    }
  } catch (err) {
    // Fail closed, SQLSTATE only (the sole bound param is the IP hash, and
    // DrizzleQueryError embeds bound params — lib/db-error.ts). 503, not 429:
    // an outage must not hide inside ordinary rate-limiting.
    console.error(
      `leads rate-limit accounting failed — refusing the request (sqlstate: ${redactedErrorCode(err)})`
    );
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
  // sending a bad `url` alongside a filled honeypot must never learn that
  // schema validation (not the honeypot) is what rejected it, and must never
  // reach createLead. Null-safe against arbitrary JSON: `body` is `unknown`
  // and may be a string, array, or null. Same silent-201 contract as
  // submitContribution's honeypot handling.
  //
  // Deliberately NOT gated on `typeof rawWebsite === "string"` — see
  // app/api/contribute/route.ts for why that gate was itself the oracle this
  // comment claims does not exist.
  const rawWebsite =
    body && typeof body === "object" && "website" in body
      ? (body as { website?: unknown }).website
      : undefined;
  if (isHoneypotTripped({ website: rawWebsite })) {
    return jsonResponse({ ok: true }, { status: 201 });
  }

  const result = await createLead(body, ipHash);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // The lead is durably saved as of here. Everything below is best-effort
  // enrichment scheduled via `after()` (same house pattern as
  // app/api/subscribe/route.ts) so it runs AFTER the response is sent and
  // never adds triage latency to the caller. Wrapped in try/catch as a final
  // backstop even though triageUrl/findFacilitiesCitingUrl already never
  // throw on their own — if the fetch hangs, errors, times out, or the
  // function is torn down mid-triage, the lead row still exists with
  // `triage = null`, which means "not checked yet," never "bad lead."
  const leadId = result.id;
  const url = result.url;
  after(async () => {
    try {
      const triage = await triageUrl(url);
      const duplicateFacilityIds = await findFacilitiesCitingUrl(url);
      await setLeadTriage(leadId, { ...triage, duplicateFacilityIds });
    } catch {
      // Swallow — a triage failure must never surface anywhere but a lead
      // left with triage = null.
    }
  });

  return jsonResponse({ ok: true }, { status: 201 });
}

// `public-write`: anonymous POST is the only handler on this path. Lead triage
// runs after the response and behind no credential, so the preflight has no
// reason to advertise `Authorization` or a destructive verb.
export function OPTIONS() {
  return corsPreflight("public-write");
}
