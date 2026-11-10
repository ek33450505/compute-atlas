import { isDatasetSharingEnabled } from "@/lib/dataset-flag";

/** Kill switch for the paid commercial dataset tier; routes check it before any Stripe, DB or body work. */
export function isCommercialTierEnabled(): boolean {
  return process.env.COMMERCIAL_TIER_ENABLED === "true";
}

/** Checkout, its return pages and billing are open only when the tier AND dataset sharing are on: the terms and downloads live behind the sharing flag. */
export function isCommercialCheckoutOpen(): boolean {
  return isCommercialTierEnabled() && isDatasetSharingEnabled();
}
