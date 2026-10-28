import { siteConfig } from "@/lib/site";
import { getCommunityReceptionCounts, getFrictionTotal } from "@/lib/data";
import { COMMUNITY_RECEPTION_META, OPPOSITION_HEADLINE } from "@/lib/community";
import { loadFrauncesFont, renderOgFallbackCard } from "@/lib/og-theme";
import { renderOgCollectionCard } from "@/lib/og-collection-card";

// Same cached read the page uses (getCommunityReceptionCounts), so rendering
// this image adds no database query of its own. Static route, so there is no
// generateStaticParams to avoid; the image still renders on demand and is
// cached for a day rather than being built with every deploy.
export const revalidate = 86400;

export const alt = `${siteConfig.name} — data center opposition and community response`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage() {
  const counts = await getCommunityReceptionCounts();
  const total = getFrictionTotal(counts);
  const fraunces = loadFrauncesFont();

  // The page renders "No documented community friction is on file yet" for an
  // empty set. A card reading "0 friction sites" would say less than nothing,
  // and an image route must never throw — a 500 here breaks link unfurling —
  // so fall back to the generic site card.
  if (total === 0) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  return renderOgCollectionCard({
    overline: "COMMUNITY RESPONSE",
    headline: OPPOSITION_HEADLINE,
    stats: [
      { value: String(total), label: "FRICTION SITES" },
      {
        value: String(counts.litigation),
        label: COMMUNITY_RECEPTION_META.litigation.label.toUpperCase(),
      },
    ],
    fraunces,
    site: siteConfig,
    size,
  });
}
