import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { checkRateLimit, extractClientIp, hashIp } from "@/lib/rate-limit";
import { submitContribution } from "@/lib/contribute";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ip = extractClientIp(request);
  const ipHash = hashIp(ip);

  const gate = await checkRateLimit(ipHash);
  if (!gate.ok) {
    return jsonResponse(
      { error: "Too many submissions. Please try again later." },
      { status: 429 }
    );
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
