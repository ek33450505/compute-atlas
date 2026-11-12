import type { SendOutcome } from "@/lib/email";

/**
 * Races a sender against `timeoutMs`: lib/email.ts `sendViaResend` has no timeout of its own, so a hung
 * Resend call would otherwise hold the whole pass until the function is killed. Resolves
 * `{ sent: false, errorCode: "send_timeout" }` on expiry; the timer is cleared on settle. The abandoned call
 * may still complete in the background (its late result is ignored), so a timeout does not prove nothing was
 * mailed.
 */
export async function sendWithTimeout(send: () => Promise<SendOutcome>, timeoutMs: number): Promise<SendOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SendOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, errorCode: "send_timeout" }), timeoutMs);
  });
  try {
    // Inside the try so a synchronous throw from `send` still clears the timer.
    const sending = send();
    sending.catch(() => {});
    return await Promise.race([sending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
