/** The single source for the commercial plans shown to visitors and quoted in mail; Stripe price ids live elsewhere. */
export const COMMERCIAL_PLANS = {
  monthly: { label: "Monthly", priceUsd: 150, cadence: "month" },
  annual: { label: "Annual", priceUsd: 1500, cadence: "year", note: "2 months free" },
} as const;

export type CommercialPlanKey = keyof typeof COMMERCIAL_PLANS;

/** Where a commercial requester is sent: the paid, self-serve page. */
export const COMMERCIAL_PATH = "/access/commercial";

/** "$150/month", "$1,500/year". */
export function formatPlanPrice(plan: CommercialPlanKey): string {
  const { priceUsd, cadence } = COMMERCIAL_PLANS[plan];
  return `$${priceUsd.toLocaleString("en-US")}/${cadence}`;
}

/** People at the buyer's organization who may use one subscription internally. */
export const COMMERCIAL_SEATS = 3;
