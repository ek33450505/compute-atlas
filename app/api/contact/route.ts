import { after } from "next/server";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { checkContactRateLimit, extractTrustedClientIp, hashIp } from "@/lib/rate-limit";
import { isHoneypotTripped } from "@/lib/contribute";
import { createContactMessage, setContactEmailSent } from "@/lib/contact";
import { sendContactEmail } from "@/lib/email";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const ipHash = hashIp(extractTrustedClientIp(request.headers));

  const gate = await checkContactRateLimit(ipHash);
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
  // never reach createContactMessage. Null-safe against arbitrary JSON: `body`
  // is `unknown` and may be a string, array, or null. Same silent-201
  // contract as app/api/leads/route.ts's honeypot handling.
  const rawWebsite =
    body && typeof body === "object" && "website" in body
      ? (body as { website?: unknown }).website
      : undefined;
  if (typeof rawWebsite === "string" && isHoneypotTripped({ website: rawWebsite })) {
    return jsonResponse({ ok: true }, { status: 201 });
  }

  const result = await createContactMessage(body, ipHash);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }

  // The message is durably saved as of here. The notification email is sent
  // via `after()` (same house pattern as app/api/subscribe/route.ts's confirm
  // email and app/api/leads/route.ts's triage) so a slow/failing Resend call
  // never adds latency to the caller or turns a stored message into a 500 —
  // `emailSent` is recorded once the send resolves, and a failure there
  // leaves the row exactly as durable as it already was.
  const { id, name, email, topic, message } = result;
  after(async () => {
    try {
      const { sent } = await sendContactEmail({ name, email, topic, message });
      await setContactEmailSent(id, sent);
    } catch {
      // Swallow — a send/record failure must never surface anywhere but a
      // message left with emailSent = false.
    }
  });

  return jsonResponse({ ok: true }, { status: 201 });
}

export function OPTIONS() {
  return corsPreflight();
}
