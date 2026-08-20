import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { checkLeadRateLimit, extractClientIp, hashIp } from "@/lib/rate-limit";
import { isHoneypotTripped } from "@/lib/contribute";
import { createLead, setLeadTriage } from "@/lib/leads";
import { triageUrl } from "@/lib/url-triage";
import { findFacilitiesCitingUrl } from "@/lib/lead-dedupe";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(extractClientIp(request));

  const gate = await checkLeadRateLimit(ipHash);
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many submissions. Please try again later." },
      { status: 429 }
    );
  }

  // Honeypot: checked against the RAW body, before any schema parsing, so a
  // bot that fills `website` gets the same silent 201 with nothing written
  // regardless of whether the rest of its payload is well-formed — a bot
  // sending a bad `url` alongside a filled honeypot must never learn that
  // schema validation (not the honeypot) is what rejected it, and must never
  // reach createLead. Null-safe against arbitrary JSON: `body` is `unknown`
  // and may be a string, array, or null. Same silent-201 contract as
  // submitContribution's honeypot handling.
  const rawWebsite =
    body && typeof body === "object" && "website" in body
      ? (body as { website?: unknown }).website
      : undefined;
  if (typeof rawWebsite === "string" && isHoneypotTripped({ website: rawWebsite })) {
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

export function OPTIONS() {
  return corsPreflight();
}
