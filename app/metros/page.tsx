import Link from "next/link";
import type { Metadata } from "next";

import { getFacilitiesByMetro } from "@/lib/data";
import { METROS } from "@/lib/metros";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";

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
