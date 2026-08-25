import Link from "next/link";
import type { Metadata } from "next";

import { getStatusCounts } from "@/lib/data";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "US data centers by status",
  description:
    "Browse tracked US data centers by lifecycle status — proposed, permitted, under construction, operational, or cancelled — each with a live, source-cited count.",
  alternates: { canonical: "/status" },
};

/**
 * /status — index hub linking to the 5 per-status SEO landing pages
 * (app/status/[status]/page.tsx). Mirrors /explore's lens-grid layout.
 * Static server component; counts are live via getStatusCounts.
 */
/**
 * Lifecycle sequence for the masthead prose. `STATUS_ORDER` is *display* order
 * (operational first); this is the order a project actually moves through, with
 * `cancelled` as the fifth stage rather than an aside. Typed `readonly Status[]`
 * so a renamed or removed status fails typecheck here. The masthead's count and
 * its enumeration both derive from this array, so they cannot disagree.
 */
const LIFECYCLE_ORDER: readonly Status[] = [
  "proposed",
  "permitted",
  "under_construction",
  "operational",
  "cancelled",
];

/** "proposed, permitted, under construction, operational, or cancelled" */
const LIFECYCLE_PROSE = (() => {
  const labels = LIFECYCLE_ORDER.map((s) => STATUS_META[s].label.toLowerCase());
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
})();

export default async function StatusIndexPage() {
  const counts = await getStatusCounts();

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "By status" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="Lifecycle status"
        title="By status"
        dek={
          <>
            Every tracked site sits in one of {LIFECYCLE_ORDER.length} lifecycle
            stages: {LIFECYCLE_PROSE}. Each stage links to the full, source-cited
            list.
          </>
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Status grid                                                         */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="status-list-heading" className="space-y-4">
        <h2 id="status-list-heading" className="sr-only">
          Browse by status
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {STATUS_ORDER.map((status) => (
            <li key={status}>
              <Link
                href={`/status/${status}`}
                className="flex min-h-11 flex-col gap-1.5 rounded-sm border border-border px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-lg text-foreground">
                    {STATUS_META[status].label}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground shrink-0">
                    {counts[status]} sites
                  </span>
                </span>
                <span className="text-sm leading-relaxed text-muted-foreground">
                  {STATUS_META[status].description}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
