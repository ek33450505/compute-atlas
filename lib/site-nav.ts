import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { siteConfig } from "@/lib/site";

export interface SiteNavLink {
  readonly label: string;
  readonly href: string;
  readonly external?: boolean;
}

export interface SiteNavGroup {
  readonly label: string;
  readonly links: readonly SiteNavLink[];
}

/** The five header items (Ed, D6). Plain links; the groups below carry the sub-links. */
export const NAV_LINKS: readonly SiteNavLink[] = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Explore", href: "/explore" },
  { label: "Dataset", href: "/dataset" },
  { label: "About", href: "/about" },
];

/**
 * The mobile sheet and the footer render these same groups, so they cannot
 * drift. Map and Table are single-link groups, so they share one "Browse"
 * heading. Dataset-access links appear only while their flag is on.
 */
export function getSiteNavGroups(): readonly SiteNavGroup[] {
  const sharing = isDatasetSharingEnabled();
  const commercial = sharing && isCommercialTierEnabled();

  const dataset: SiteNavLink[] = [{ label: "Dataset", href: "/dataset" }];
  if (commercial) dataset.push({ label: "Dataset subscription", href: "/access/commercial" });
  if (sharing) dataset.push({ label: "Free access for students", href: "/access" });
  dataset.push({ label: "Cite & license", href: "/data" });

  return [
    {
      label: "Browse",
      links: [
        { label: "Map", href: "/map" },
        { label: "Table", href: "/table" },
      ],
    },
    {
      label: "Explore",
      links: [
        { label: "All lenses", href: "/explore" },
        { label: "States", href: "/states" },
        { label: "By status", href: "/status" },
        { label: "By metro", href: "/metros" },
        { label: "Power", href: "/power" },
        { label: "Opposition", href: "/opposition" },
        { label: "Stats", href: "/stats" },
        { label: "Activity", href: "/activity" },
      ],
    },
    { label: "Dataset", links: dataset },
    {
      label: "About",
      links: [
        { label: "About", href: "/about" },
        { label: "Methodology", href: "/methodology" },
        { label: "Contribute", href: "/contribute" },
        { label: "Contributors", href: "/contributors" },
        { label: "Support", href: "/support" },
        { label: "Contact", href: "/contact" },
        { label: "Source on GitHub", href: siteConfig.repoUrl, external: true },
        { label: "Bluesky", href: siteConfig.blueskyUrl, external: true },
        { label: "Newsletter", href: siteConfig.newsletterUrl, external: true },
      ],
    },
  ];
}

/** Internal pages for the command palette: the five header items plus every group link, once each. */
export function getPaletteLinks(): readonly { label: string; href: string }[] {
  const seen = new Set<string>();
  const out: { label: string; href: string }[] = [];
  const all = [...NAV_LINKS, ...getSiteNavGroups().flatMap((g) => g.links)];
  for (const { label, href, external } of all) {
    if (external || seen.has(href)) continue;
    seen.add(href);
    out.push({ label, href });
  }
  return out;
}
