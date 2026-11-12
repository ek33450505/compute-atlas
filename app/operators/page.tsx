import Link from "next/link";
import type { Metadata } from "next";

import { getOperators, getOperatorSummary, getAllFacilities, operatorSlug } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";
import { LetterNav } from "@/components/collection/letter-nav";
import { letterLabel, letterOf, lettersInUse, parseLetter } from "@/lib/letter-index";
import { itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

/** Rows on the default view: the largest operators by disclosed capacity. */
const TOP_COUNT = 48;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const letter = parseLetter((await searchParams).letter);
  const description =
    "Browse the U.S. compute buildout by operator — the largest companies by capacity, then every tracked data-center, crypto-mining, or power-generation operator A–Z by letter, each record source-cited.";
  if (!letter) {
    return {
      title: "Data centers by operator",
      description,
      alternates: { canonical: "/operators" },
    };
  }
  return {
    title: `Data center operators: ${letterLabel(letter)}`,
    description,
    alternates: { canonical: `/operators?letter=${letter}` },
  };
}

const ROW_CLASS =
  "flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * /operators — index of all tracked operators, paged A–Z.
 *
 * With no (or an invalid) `?letter=`, lists the largest operators by total
 * capacity (operational + planned) desc — many top operators are planned-only
 * buildouts, so operational alone would bury them (tie-break: facility count
 * desc, then name A→Z). With `?letter=x`, lists the operators starting with
 * that letter A→Z, including those with no disclosed capacity. Every operator
 * is reachable from a letter link.
 *
 * Why paged: the full list of 1,500+ rows was a 2.7 MB document (audit U-11),
 * and the RSC payload repeats rendered markup. Reading `searchParams` makes
 * the route dynamic; the data still comes through the 24 h-cached
 * `loadFacilities()` loader (`getOperators` / `getOperatorSummary` /
 * `getAllFacilities`), as /table does, so there is no extra DB read.
 */
export default async function OperatorsIndexPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const letter = parseLetter((await searchParams).letter);
  const operatorNames = await getOperators();
  const rows = (
    await Promise.all(
      operatorNames.map(async (name) => {
        const summary = (await getOperatorSummary(name))!;
        return {
          name,
          slug: operatorSlug(name),
          summary,
          total: summary.operationalMw + summary.plannedMw,
        };
      })
    )
  ).sort(
    (a, b) =>
      b.total - a.total ||
      b.summary.count - a.summary.count ||
      a.name.localeCompare(b.name)
  );

  const disclosed = rows.filter((r) => r.total > 0);
  const totalDisclosedMw = disclosed.reduce((sum, r) => sum + r.total, 0);
  const available = lettersInUse(operatorNames);

  const shown = letter
    ? rows
        .filter((r) => letterOf(r.name) === letter)
        .sort((a, b) => a.name.localeCompare(b.name))
    : disclosed.slice(0, TOP_COUNT);

  const totalFacilities = (await getAllFacilities()).length;
  const listHeading = letter
    ? `Operators starting with ${letterLabel(letter)}`
    : `Largest ${shown.length} operators by capacity`;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            shown.map(({ name, slug }) => ({
              name,
              url: `${siteConfig.url}/operators/${slug}`,
            }))
          ),
        }}
      />
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Operators" }]} />

      <PageMasthead
        eyebrow="By company"
        title="Operators"
        dek="Who is building it. The largest operators by disclosed megawatts come first; every tracked operator is also listed A–Z by the first letter of its name, with digit-first and other names under “0–9 & other”. Operators with no disclosed figure are listed under their letter — undisclosed is not the same as small."
      />

      <SurveyStatRow
        stats={[
          { value: rows.length.toLocaleString(), label: "Operators" },
          { value: disclosed.length.toLocaleString(), label: "With capacity" },
          { value: totalFacilities.toLocaleString(), label: "Facilities" },
          { value: formatPower(totalDisclosedMw), label: "Disclosed" },
        ]}
      />

      <section
        aria-labelledby="operators-overview-heading"
        className="max-w-2xl space-y-4"
      >
        <h2
          id="operators-overview-heading"
          className="font-display text-2xl text-foreground"
        >
          How the list is organized
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          The first view ranks operators by operational plus planned capacity,
          because much of the largest buildout is still unbuilt — ranking on
          operational alone would bury the companies with the biggest
          pipelines. Every operator, including those that have never
          published a megawatt figure, is listed A–Z under the first letter of its name; names that start with a digit or any other character are under &ldquo;0&ndash;9 &amp; other&rdquo;.
        </p>
      </section>

      <section aria-labelledby="operators-list-heading" className="space-y-4">
        <LetterNav
          basePath="/operators"
          label="Operators by first letter"
          available={available}
          current={letter}
        />
        <h2
          id="operators-list-heading"
          className="font-display text-2xl text-foreground"
        >
          {listHeading}
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {shown.map(({ name, slug, summary, total }) => (
            <li key={slug}>
              <Link href={`/operators/${slug}`} className={ROW_CLASS}>
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">{name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {total > 0 ? `${formatPower(total)} total` : "No disclosed capacity"}
                  </span>
                </span>
                <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
                  {summary.count} {summary.count === 1 ? "site" : "sites"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
