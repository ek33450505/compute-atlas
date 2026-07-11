import Link from "next/link";
import type { Metadata } from "next";

import { getOperators, getOperatorSummary, getAllFacilities, operatorSlug } from "@/lib/data";

/** Formats a MW figure as GW (1 decimal) above 1000, else whole MW. Avoids "0.0 GW" for small operators. */
function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

export const metadata: Metadata = {
  title: "Operators",
  description:
    "Browse the U.S. compute buildout by operator — every company running tracked data-center, crypto-mining, or power-generation capacity, each record source-cited.",
};

/**
 * /operators — index of all tracked operators. Static server component.
 *
 * Links to /operators/[operator] for each operator with at least one tracked
 * facility, sorted by total capacity (operational + planned) desc — many top
 * operators are planned-only buildouts, so operational alone would bury them
 * (tie-break: facility count desc, then name A→Z). Operators with zero
 * disclosed capacity are split into a collapsed <details> toggle below the
 * main grid rather than diluting it.
 */
export default function OperatorsIndexPage() {
  const rows = getOperators()
    .map((name) => {
      const summary = getOperatorSummary(name)!;
      return {
        name,
        slug: operatorSlug(name),
        summary,
        total: summary.operationalMw + summary.plannedMw,
      };
    })
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.summary.count - a.summary.count ||
        a.name.localeCompare(b.name)
    );

  const disclosed = rows.filter((r) => r.total > 0);
  const undisclosed = rows.filter((r) => r.total === 0);

  const totalFacilities = getAllFacilities().length;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      {/* Back link */}
      <Link
        href="/map"
        className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      >
        ← Back to the map
      </Link>

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          By operator
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Operators
        </h1>
        <p className="text-base text-muted-foreground">
          {rows.length} operators &middot; {disclosed.length} with disclosed
          capacity &middot; {totalFacilities} facilities tracked
        </p>
        <div className="border-t border-border" />
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Operator grid                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="operators-list-heading" className="space-y-4">
        <h2 id="operators-list-heading" className="sr-only">
          All tracked operators
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {disclosed.map(({ name, slug, summary, total }) => (
            <li key={slug}>
              <Link
                href={`/operators/${slug}`}
                className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm text-foreground truncate">
                    {name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatPower(total)} total
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

      {/* ------------------------------------------------------------------ */}
      {/* Zero-capacity operators — collapsed by default                     */}
      {/* ------------------------------------------------------------------ */}
      {undisclosed.length > 0 && (
        <details className="group border-t border-border pt-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Show {undisclosed.length} operators with no disclosed capacity
            <span
              aria-hidden="true"
              className="transition-transform motion-reduce:transition-none group-open:rotate-90"
            >
              →
            </span>
          </summary>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {undisclosed.map(({ name, slug, summary }) => (
              <li key={slug}>
                <Link
                  href={`/operators/${slug}`}
                  className="flex min-h-11 items-center justify-between gap-4 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm text-foreground truncate">
                      {name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      No disclosed capacity
                    </span>
                  </span>
                  <span className="font-mono tabular-nums text-sm text-muted-foreground shrink-0">
                    {summary.count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
