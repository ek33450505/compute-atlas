import Link from "next/link";
import type { Metadata } from "next";

import { getFacilitiesByMetro } from "@/lib/data";
import { METROS, metroCountyKey } from "@/lib/metros";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SurveyStatRow } from "@/components/survey-stat-row";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "US data centers by metro",
  description:
    "Browse tracked US data centers by metro area — curated county clusters known for AI data center, crypto-mining, and power-generation activity — each with a live, source-cited count.",
  alternates: { canonical: "/metros" },
};

interface MetroCount {
  slug: string;
  name: string;
  count: number;
}

/**
 * /metros — index hub linking to the 27 per-metro SEO landing pages
 * (app/metros/[metro]/page.tsx). Mirrors /status's lens-grid layout.
 * Static server component; counts are live via getFacilitiesByMetro
 * (cached — 27 cheap calls over the same loadFacilities() cache, not 27
 * separate DB reads).
 */
export default async function MetrosIndexPage() {
  const counts: MetroCount[] = await Promise.all(
    METROS.map(async (m) => ({
      slug: m.slug,
      name: m.name,
      count: (await getFacilitiesByMetro(m.slug)).length,
    }))
  );
  const sorted = [...counts].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );

  const countyKeys = new Set<string>();
  const stateCodes = new Set<string>();
  for (const m of METROS) {
    for (const [state, county] of m.counties) {
      countyKeys.add(metroCountyKey(state, county));
    }
    for (const state of m.states) {
      stateCodes.add(state);
    }
  }
  // Facilities inside a tracked metro only — a subset of the full dataset
  // (this lens is deliberately partial, see the overview prose below), so
  // this must NOT be labeled "Facilities" the way /states and /operators
  // label their full-dataset totalFacilities. Naming it distinctly here is
  // what keeps that labelling slip from recurring.
  const facilitiesInMetros = counts.reduce((sum, m) => sum + m.count, 0);

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "By metro" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="Metro areas"
        title="By metro"
        dek="Curated clusters of counties driving the buildout, from Northern Virginia to the Permian Basin. Each metro links to the full, source-cited list."
      />

      {/* ------------------------------------------------------------------ */}
      {/* Survey stats row                                                    */}
      {/* ------------------------------------------------------------------ */}
      <SurveyStatRow
        stats={[
          { value: METROS.length.toLocaleString(), label: "Metros" },
          { value: countyKeys.size.toLocaleString(), label: "Counties" },
          { value: stateCodes.size.toLocaleString(), label: "States" },
          { value: facilitiesInMetros.toLocaleString(), label: "In a metro" },
        ]}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Overview prose                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section
        aria-labelledby="metros-overview-heading"
        className="max-w-2xl space-y-4"
      >
        <h2
          id="metros-overview-heading"
          className="font-display text-2xl text-foreground"
        >
          How a metro is defined
        </h2>
        <p className="text-base leading-relaxed text-muted-foreground">
          A metro here is a hand-picked cluster of counties, not a Census
          statistical area. A facility joins one by matching a (state,
          county) pair — county names repeat across states, so both halves
          have to match. The clusters were chosen for known data-center,
          crypto-mining, or generation activity, which makes this lens
          deliberately partial: a tracked facility outside these counties is
          still in the dataset, it just doesn&apos;t belong to a metro.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Metro grid                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="metro-list-heading" className="space-y-4">
        <h2 id="metro-list-heading" className="sr-only">
          Browse by metro
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {sorted.map((m) => (
            <li key={m.slug}>
              <Link
                href={`/metros/${m.slug}`}
                className="flex min-h-11 items-baseline justify-between gap-2 rounded-sm border border-border px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="font-display text-lg text-foreground">
                  {m.name}
                </span>
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {m.count} {m.count === 1 ? "site" : "sites"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
