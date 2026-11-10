/** Kill switch for the paid commercial dataset tier; routes check it before any Stripe, DB or body work. */
export function isCommercialTierEnabled(): boolean {
  return process.env.COMMERCIAL_TIER_ENABLED === "true";
}
