/**
 * Canonical form of a subscriber address: trim + lowercase.
 * `subscribeToTarget` (lib/subscribe.ts) applies it before storing
 * `subscriptions.email`, so every keyed or hashed use of an address (consent
 * cookie tag, suppression list, send log) agrees on one input. Lives in its
 * own module because lib/suppressions.ts and lib/subscribe-consent.ts both
 * need it and suppressions already imports subscribe-consent.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
