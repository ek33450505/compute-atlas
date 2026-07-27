import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { checkSubscribeRateLimit, extractClientIp, hashIp } from "@/lib/rate-limit";
import { subscribeToTarget } from "@/lib/subscribe";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(extractClientIp(request));

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

  return jsonResponse({ ok: true }, { status: 201 });
}

export function OPTIONS() {
  return corsPreflight();
}
