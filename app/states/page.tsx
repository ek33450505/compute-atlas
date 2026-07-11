import Link from "next/link";
import type { Metadata } from "next";

import { getStates, getStateSummary, getAllFacilities } from "@/lib/data";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";
import { Breadcrumb } from "@/components/breadcrumb";

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small states. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

export const metadata: Metadata = {
  title: "States",
  description:
    "Browse the U.S. grid-scale compute buildout state by state — facility counts, capacity, and build status, each record source-cited.",
};

/**
 * /states — index of all tracked states. Static server component.
 *
 * Links to /states/[state] for each state with at least one tracked
 * facility, sorted by facility count desc (tie-break: name A→Z).
 */
export default function StatesIndexPage() {
  const rows = getStates()
    .map((code) => ({
      code,
      name: stateNameFromCode(code)!,
      slug: stateSlugFromCode(code)!,
      summary: getStateSummary(code)!,
    }))
    .sort(
      (a, b) =>
        b.summary.count - a.summary.count || a.name.localeCompare(b.name)
    );

  const totalFacilities = getAllFacilities().length;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "States" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          By geography
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          States
        </h1>
        <p className="text-base text-muted-foreground">
          {rows.length} states &middot; {totalFacilities} facilities tracked
        </p>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* State grid                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="states-list-heading" className="space-y-4">
        <h2 id="states-list-heading" className="sr-only">
          All tracked states
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map(({ code, name, slug, summary }) => (
            <li key={code}>
              <Link
                href={`/states/${slug}`}
                className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">
                    {name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatPower(summary.operationalMw)} operational
                  </span>
                </span>
                <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
                  {summary.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
