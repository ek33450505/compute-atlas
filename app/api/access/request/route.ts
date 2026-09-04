import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { sendBulkAccessEmail } from "@/lib/email";
import {
  checkAccessGrantRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
} from "@/lib/rate-limit";
import { requestAccessGrant } from "@/lib/access-grants";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));

  const gate = await checkAccessGrantRateLimit(ipHash);
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  const result = await requestAccessGrant(body, ipHash);

  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // Scheduled to run AFTER the response is sent (same timing-leak fix as
  // app/api/subscribe/route.ts, s65 security review): sending inline here
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

export function OPTIONS() {
  return corsPreflight();
}
