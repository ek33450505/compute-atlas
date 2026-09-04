import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { checkRateLimit, extractTrustedClientIp, hashIp, normaliseIpForBucketing } from "@/lib/rate-limit";
import { isHoneypotTripped, submitContribution } from "@/lib/contribute";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(normaliseIpForBucketing(extractTrustedClientIp(request.headers)));

  const gate = await checkRateLimit(ipHash);
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many submissions. Please try again later." },
      { status: 429 }
    );
  }

  // Honeypot: checked against the RAW body, before any schema parsing, so a
  // bot that fills `website` gets the same silent 201 with nothing written
  // regardless of whether the rest of its payload is well-formed — a bot
  // sending e.g. a bad `email` alongside a filled honeypot must never learn
  // that schema validation (not the honeypot) is what rejected it, and must
  // never reach submitContribution. Null-safe against arbitrary JSON: `body`
  // is `unknown` and may be a string, array, or null. Same silent-201
  // contract as app/api/leads/route.ts's honeypot handling.
  const rawWebsite =
    body && typeof body === "object" && "website" in body
      ? (body as { website?: unknown }).website
      : undefined;
  if (typeof rawWebsite === "string" && isHoneypotTripped({ website: rawWebsite })) {
    return jsonResponse({ ok: true }, { status: 201 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await submitContribution(body, ipHash, today);

  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  return jsonResponse({ ok: true }, { status: 201 });
}

export function OPTIONS() {
  return corsPreflight();
}
