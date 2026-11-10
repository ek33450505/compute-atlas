import { after } from "next/server";

import { corsPreflight, jsonResponse, methodNotAllowed, notAvailable } from "@/lib/api-response";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { requestDatasetAccess } from "@/lib/dataset-grants";
import { deliverDatasetRequestMail } from "@/lib/dataset-mail";
import { redactedErrorCode } from "@/lib/db-error";
import { readJsonBody } from "@/lib/read-json-body";
import {
  checkIntakeRateLimit,
  extractTrustedClientIp,
  hashIp,
  normaliseIpForBucketing,
  recordIntakeAttempt,
} from "@/lib/rate-limit";

const UNAVAILABLE = { error: "Requests are temporarily unavailable. Please try again later." };

/**
 * Approved-access dataset request. Every valid outcome answers the same fixed `202 {ok:true}`, so the
 * response never reveals whether the address is new, pending, active, rejected, capped or suppressed.
 */
export async function POST(request: Request) {
  // Kill switch first: no DB call, no body read.
  if (!isDatasetSharingEnabled()) return notAvailable();

  // Gate on PRIOR attempts, then record this one BEFORE any content-dependent branch (same ordering as
  // app/api/contribute/route.ts, whose comments give the reasoning): invalid JSON, a validation failure,
  // the honeypot and a real request each cost exactly one unit. The refused (429) request records nothing.
  let gate: { ok: boolean };
  let ipHash: string;
  try {
    ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));
    gate = await checkIntakeRateLimit("access-request", ipHash);
    if (gate.ok) await recordIntakeAttempt("access-request", ipHash);
  } catch (err) {
    // Fail closed, SQLSTATE only (bound params include the IP hash). 503, not 429: an outage is not shaping.
    console.error(`access-request rate-limit accounting failed (sqlstate: ${redactedErrorCode(err)})`);
    return jsonResponse(UNAVAILABLE, { status: 503 });
  }
  if (!gate.ok) {
    return jsonResponse({ error: "Too many requests. Please try again later." }, { status: 429 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return parsed.reason === "too_large"
      ? jsonResponse({ error: "Request body too large" }, { status: 413 })
      : jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof requestDatasetAccess>>;
  try {
    result = await requestDatasetAccess(parsed.body, ipHash);
  } catch (err) {
    console.error(`access-request failed (sqlstate: ${redactedErrorCode(err)})`);
    return jsonResponse(UNAVAILABLE, { status: 503 });
  }
  if (!result.ok && result.status === 422) {
    // Decided by the submitted category alone (no address lookup), so it is not an enumeration oracle.
    return jsonResponse({ error: result.error, path: result.path }, { status: 422 });
  }
  if (!result.ok) {
    // Decided by the input alone, so it is not an enumeration oracle.
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  const mail = result.mail;
  if (mail) {
    if (mail.kind === "dataset_verify" || mail.kind === "dataset_already_active") {
      after(() => deliverDatasetRequestMail(mail));
    } else {
      console.error("access-request produced an unexpected mail intent; not sent");
    }
  }

  // A FIXED literal: never serialize `result`, whose `mail` holds raw tokens on the mailing paths.
  return jsonResponse({ ok: true }, { status: 202 });
}

// `public-write`: anonymous POST only; the path exports no PATCH/DELETE.
export function OPTIONS() {
  return corsPreflight("public-write");
}

// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
export function GET() {
  return methodNotAllowed(["POST", "OPTIONS"]);
}
