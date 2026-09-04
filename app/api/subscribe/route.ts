import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { sendConfirmEmail } from "@/lib/email";
import {
  checkSubscribeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
} from "@/lib/rate-limit";
import { subscribeToTarget } from "@/lib/subscribe";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));

  const gate = await checkSubscribeRateLimit(ipHash);
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
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
