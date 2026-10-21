/**
 * Canonical form of a subscriber address: trim + lowercase. Identical to
 * the `data.email.trim().toLowerCase()` that `subscribeToTarget`
 * (lib/subscribe.ts) applies inline before storing `subscriptions.email`
 * (that call site does not use this helper), so every keyed or hashed use of an address (consent
 * cookie tag, suppression list, send log) agrees on one input. Lives in its
 * own module because lib/suppressions.ts and lib/subscribe-consent.ts both
 * need it and suppressions already imports subscribe-consent.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
