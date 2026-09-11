import type { Metadata } from "next";
import Link from "next/link";

import { getContributorCredits, type ContributorCredit } from "@/lib/data";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { slugify } from "@/lib/operator-slug";
import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Contributors",
  description:
    "Public thanks to the people who opted in to be credited for a source-cited correction or addition to Compute Atlas.",
  alternates: { canonical: "/contributors" },
};

const CRUMBS = [{ label: "About", href: "/about" }, { label: "Contributors" }];

/** A `ContributorCredit` plus its deduped anchor fragment — see `buildCreditsWithFragments`. */
type CreditWithFragment = ContributorCredit & { fragment: string };

/**
 * `slugify()` (lib/operator-slug.ts) collapses ANY run of non-alphanumerics,
 * so distinct attributions that differ only in punctuation — "Jane Doe" vs
 * "Jane-Doe" vs "Jane_Doe" — all produce the same fragment. The dedupe query
 * in `getContributorCredits` (lib/data.ts) groups on a coarser key
 * (`lower(trim(...))`) than that, so `credits` can legitimately contain rows
 * whose slugs collide even though every `attribution` string here is unique.
 * Compute the fragment ONCE over the whole array, in render order (which is
 * already the query's deterministic `count desc, normalized asc` order), so
 * collisions get deterministic `-2`, `-3`, ... suffixes and the JSON-LD `url`
 * and the `<li id>` can never disagree. Also guards the edge case where an
 * attribution is punctuation-only and slugifies to "". Returns an enriched
 * array (rather than a lookup `Map`) so callers get a required `fragment:
 * string` field instead of `Map#get`'s `string | undefined`.
 */
function buildCreditsWithFragments(credits: ContributorCredit[]): CreditWithFragment[] {
  const used = new Set<string>();

  return credits.map((credit) => {
    const base = slugify(credit.attribution) || "contributor";
    let fragment = base;
    let suffix = 2;
    while (used.has(fragment)) {
      fragment = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(fragment);
    return { ...credit, fragment };
  });
}

/**
 * /contributors — public credit for people who filled the optional
 * attribution field on a submission and had it approved. Static-shaped
 * server component (async only for the data fetch); no client state.
 *
 * Deliberately does NOT reuse `components/collection/collection-page.tsx`:
 * that primitive's card grid (`CollectionFacilityCard`) and its
 * `CollectionJsonLd` both hard-code `Facility[]` — operator/status/location/
 * capacity fields and a `/facilities/[id]` link that a contributor handle
 * doesn't have. This instead follows the `/stakeholders` page's shape (a
 * name+count directory with no per-item detail route): `Breadcrumb` +
 * `PageMasthead` + `SurveyStatRow`, all of which are already generic.
 *
 * The credited list itself is a single-column, divide-y row list (mirrors
 * `app/activity/activity-list.tsx`'s rhythm), not a multi-column card grid
 * like `ShowMoreList`'s facility grid or `/stakeholders`'s 2-up boxes.
 * Measured against live prod (2026-09-11): exactly ONE distinct opted-in
 * handle exists today ("Public Evidence Project", 8 approved credits) — a
 * bordered 2-column card grid with a single tile reads as broken (an empty
 * second column, a lonely box), where a single divided row reads as a
 * complete, honest list at any length, including one.
 *
 * Sparse by design: opt-in attribution is a new, optional field, so the real
 * contributor count may be zero or near-zero for a long time. Both the
 * n=0 empty state below and the near-empty (currently n=1) populated state
 * are the expected render for most of this page's life, not placeholders to
 * replace later.
 */
export default async function ContributorsPage() {
  const credits = await getContributorCredits();
  const totalCredits = credits.reduce((sum, c) => sum + c.count, 0);
  const creditsWithFragments = buildCreditsWithFragments(credits);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: breadcrumbJsonLdString(
          CRUMBS.map((c) => ({ name: c.label, url: c.href }))
        ) }}
      />
      {creditsWithFragments.length > 0 && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: itemListJsonLdString(
            creditsWithFragments.map((c) => ({
              name: c.attribution,
              url: `${siteConfig.url}/contributors#${c.fragment}`,
            }))
          ) }}
        />
      )}

      <Breadcrumb items={CRUMBS} />

      <PageMasthead
        eyebrow="People"
        title="Contributors"
        dek="Public thanks to the people who chose to be credited for a source-cited correction or addition. Attribution is opt-in: most contributions land with no name attached, and that is fine — this page lists only the handles their owners chose to make public."
      />

      {credits.length === 0 ? (
        <section className="max-w-2xl space-y-4">
          <p className="text-base leading-relaxed text-muted-foreground">
            No public credits yet. Attribution is an optional field on{" "}
            <Link
              href="/contribute"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              every submission
            </Link>{" "}
            — leave it blank to stay anonymous, or fill it in and an approved
            contribution will show up here.
          </p>
        </section>
      ) : (
        <>
          <SurveyStatRow
            stats={[
              { value: credits.length.toLocaleString(), label: "Contributors" },
              { value: totalCredits.toLocaleString(), label: "Credited contributions" },
            ]}
          />

          <section aria-labelledby="contributors-list-heading" className="space-y-4">
            <h2 id="contributors-list-heading" className="sr-only">
              All credited contributors
            </h2>
            <ul className="max-w-2xl divide-y divide-border border-t border-b border-border">
              {creditsWithFragments.map(({ attribution, count, fragment }) => (
                <li
                  key={attribution}
                  id={fragment}
                  className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3"
                >
                  <span className="text-sm text-foreground truncate">{attribution}</span>
                  <span className="font-mono tabular-nums text-xs text-muted-foreground shrink-0">
                    {count} {count === 1 ? "contribution" : "contributions"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="max-w-2xl space-y-4 border-t border-border pt-10">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Want to be listed here?{" "}
              <Link
                href="/contribute"
                className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                Submit a correction or addition
              </Link>{" "}
              and add a public handle in the optional attribution field.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
