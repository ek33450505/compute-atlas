import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import type { Crumb } from "@/components/breadcrumb";
import type { Facility } from "@/lib/schema";

export interface CollectionJsonLdProps {
  crumbs: Crumb[];
  facilities: Facility[];
}

/**
 * BreadcrumbList + ItemList JSON-LD `<script>` pair shared by every
 * collection-style page. `CollectionPage` renders this internally; pages
 * that can't adopt `CollectionPage` wholesale (states/[state],
 * operators/[operator], /crypto, /rankings) render it directly instead of
 * hand-rolling the same two `<script>` tags. `facilities` need not be the
 * page's full facility set — /rankings passes its ranked `topProjects`
 * subset, matching what it JSON-LD'd before this was extracted.
 */
export function CollectionJsonLd({ crumbs, facilities }: CollectionJsonLdProps) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            crumbs.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            facilities.map((f) => ({
              name: f.name,
              url: `${siteConfig.url}/facilities/${f.id}`,
            }))
          ),
        }}
      />
    </>
  );
}
