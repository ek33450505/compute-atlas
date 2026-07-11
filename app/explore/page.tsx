import Link from "next/link";
import type { Metadata } from "next";

import { getStates, getOperators } from "@/lib/data";
import { Breadcrumb } from "@/components/breadcrumb";

export const metadata: Metadata = {
  title: "Explore",
  description:
    "Browse the atlas by lens — states, power generation, community opposition, and operators.",
};

const LENSES = [
  {
    label: "States",
    href: "/states",
    description:
      "Every tracked state, with capacity, build status, and community friction.",
  },
  {
    label: "Power",
    href: "/power",
    description:
      "Dedicated generation feeding the buildout, by offtaker and technology.",
  },
  {
    label: "Opposition",
    href: "/opposition",
    description:
      "The sites facing documented community friction, with sources.",
  },
  {
    label: "Operators",
    href: "/operators",
    description:
      "Every company running tracked capacity, ranked by build-out.",
  },
] as const;

/**
 * /explore — landing page for the atlas's data-lens pages. Static server
 * component. Replaces the former header dropdown with a dedicated page.
 */
export default function ExplorePage() {
  const stateCount = getStates().length;
  const operatorCount = getOperators().length;

  const stats: Partial<Record<(typeof LENSES)[number]["label"], string>> = {
    States: `${stateCount} states`,
    Operators: `${operatorCount} operators`,
  };

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Map", href: "/map" }, { label: "Explore" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          The atlas, by lens
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Explore
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          The same dataset, sliced four ways — by geography, by power source,
          by community reception, and by who&rsquo;s building it.
        </p>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Lens grid                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="explore-list-heading" className="space-y-4">
        <h2 id="explore-list-heading" className="sr-only">
          Explore by lens
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {LENSES.map(({ label, href, description }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex min-h-11 flex-col gap-1.5 rounded-sm border border-border px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-lg text-foreground">
                    {label}
                  </span>
                  {stats[label] && (
                    <span className="font-mono text-xs text-muted-foreground shrink-0">
                      {stats[label]}
                    </span>
                  )}
                </span>
                <span className="text-sm leading-relaxed text-muted-foreground">
                  {description}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
