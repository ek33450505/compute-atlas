/**
 * Community-reception metadata (sourced local-reception status).
 *
 * Mirrors the small ordered-meta-map pattern in lib/facility-type.ts and
 * lib/status.ts. Kept to labels/order only — no color field, since the
 * site voice is neutral/de-sell and does not editorialize reception with
 * color (see app/stats/page.tsx community-reception section).
 */

/**
 * H1 of /opposition and the headline of its share card. One string, so the card
 * and the page it unfurls cannot drift apart. (A page.tsx may not export
 * arbitrary names, so it lives here.)
 */
export const OPPOSITION_HEADLINE = "Data center opposition across the United States";

export const COMMUNITY_RECEPTION_ORDER = [
  "supported",
  "mixed",
  "contested",
  "opposed",
  "litigation",
  "unknown",
] as const;

export type CommunityReception = (typeof COMMUNITY_RECEPTION_ORDER)[number];

export interface CommunityReceptionMeta {
  label: string;
}

export const COMMUNITY_RECEPTION_META: Record<CommunityReception, CommunityReceptionMeta> = {
  supported: { label: "Supported" },
  mixed: { label: "Mixed" },
  contested: { label: "Contested" },
  opposed: { label: "Opposed" },
  litigation: { label: "In litigation" },
  unknown: { label: "Unknown" },
};

/**
 * Returns the CommunityReceptionMeta for a given community reception value.
 */
export function getCommunityReceptionMeta(r: CommunityReception): CommunityReceptionMeta {
  return COMMUNITY_RECEPTION_META[r];
}
