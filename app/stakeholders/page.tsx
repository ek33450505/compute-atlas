import Link from "next/link";
import type { Metadata } from "next";

import { getStakeholders } from "@/lib/data";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";
import { formatStakeholderRole } from "./format-role";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Stakeholders",
  description:
    "Named people with a documented, source-cited stake in a specific tracked facility — founders, owners, investors, executives, board members, landowners, and public officials.",
  alternates: { canonical: "/stakeholders" },
};

/**
 * /stakeholders — index of every named person with a documented stake in at
 * least one tracked facility. Static server component.
 *
 * Sparse by design at launch: `stakeholders` is a new, still-mostly-
 * unpopulated field on `Facility` (see lib/schema.ts) that back-fills over
 * time as sourced entries land — this page (and the per-person hub) must
 * render correctly, and emptily, before that data exists.
 */
export default async function StakeholdersIndexPage() {
  const people = await getStakeholders();
  const stateCount = new Set(people.flatMap((p) => p.states)).size;
  const totalFacilityLinks = people.reduce((sum, p) => sum + p.facilityCount, 0);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            people.map(({ name, slug }) => ({
              name,
              url: `${siteConfig.url}/stakeholders/${slug}`,
            }))
          ),
        }}
      />
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Stakeholders" }]} />

      <PageMasthead
        eyebrow="People"
        title="Stakeholders"
        dek="Named people with a documented stake in specific tracked facilities — founders, owners, investors, executives, board members, landowners, and public officials with an on-record role."
      />

      <section className="max-w-2xl space-y-4">
        <p className="text-base leading-relaxed text-muted-foreground">
          A person is listed here against a facility only where a cited
          source ties them to that specific site &mdash; not merely to its
          operator. Public officials are listed for a documented role in a
          site&rsquo;s approval or funding; listing does not by itself imply
          a financial interest. This page grows as sourced entries land, so
          most tracked facilities carry no stakeholder record yet.
        </p>
      </section>

      <SurveyStatRow
        stats={[
          { value: people.length.toLocaleString(), label: "People" },
          { value: totalFacilityLinks.toLocaleString(), label: "Facility links" },
          { value: stateCount.toLocaleString(), label: "States" },
        ]}
      />

      {people.length === 0 ? (
        <p className="text-base text-muted-foreground">
          No stakeholders are on file yet. Check back soon &mdash; this page
          fills in as sourced entries are added.
        </p>
      ) : (
        <section aria-labelledby="stakeholders-list-heading" className="space-y-4">
          <h2 id="stakeholders-list-heading" className="sr-only">
            All tracked stakeholders
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {people.map(({ name, slug, roles, facilityCount, states }) => (
              <li key={slug}>
                <Link
                  href={`/stakeholders/${slug}`}
                  className="flex min-h-11 flex-col gap-1 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-foreground truncate">{name}</span>
                    <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                      {facilityCount} {facilityCount === 1 ? "site" : "sites"}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-muted-foreground truncate">
                    {roles.map(formatStakeholderRole).join(", ")} &middot; {states.join(", ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
