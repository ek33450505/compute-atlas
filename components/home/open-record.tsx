import Link from "next/link";
import type { ReactNode } from "react";

import { ActivityList } from "@/app/activity/activity-list";
import type { ActivityEntry } from "@/lib/data";

export interface OpenRecordProps {
  sources: number;
  recentActivity: ActivityEntry[];
  className?: string;
}

interface ProvenanceFact {
  label: string;
  value: string;
  sub: ReactNode;
}

// Mono-underline trailing-link idiom, copied verbatim from the trailing
// links in components/home/lens-gateway.tsx so the closing band reads as
// part of the same visual language as the rest of the page.
const TRAILING_LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/**
 * Closing band for the home page — the credibility/trust close. Provenance
 * facts (sources cited / moderation / license / API+RSS access), a
 * contribute CTA, and the recent-activity stream (only when non-empty, e.g.
 * omitted entirely on the local JSON fallback with no DB). Server
 * component: no client state needed.
 */
export function OpenRecord({
  sources,
  recentActivity,
  className,
}: OpenRecordProps) {
  const facts: ProvenanceFact[] = [
    {
      label: "Sources cited",
      value: sources.toLocaleString("en-US"),
      sub: "Every facility traces to at least one public source.",
    },
    {
      label: "Moderation",
      value: "Human-gated",
      sub: "No site goes live without a person reviewing it.",
    },
    {
      label: "License",
      value: "Open data",
      sub: "Code under MIT, data under CC BY 4.0.",
    },
    {
      label: "Access",
      value: "API + RSS",
      sub: (
        <>
          <Link href="/api" className={TRAILING_LINK_CLASS}>
            JSON API
          </Link>{" "}
          ·{" "}
          <a href="/activity/feed.xml" className={TRAILING_LINK_CLASS}>
            RSS feed
          </a>
        </>
      ),
    },
  ];

  return (
    <section aria-labelledby="record-heading" className={className}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § How this is kept
      </p>
      <h2
        id="record-heading"
        className="mt-1 font-display text-2xl text-foreground"
      >
        A living, open record
      </h2>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        Compute Atlas is built and corrected in the open. Every figure traces
        to a public source, nothing goes live without a human review, and the
        whole dataset is free to reuse.
      </p>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((fact) => (
          <li
            key={fact.label}
            className="neatline rounded-sm border border-border p-4"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {fact.label}
            </p>
            <p className="mt-1 font-display text-lg text-foreground">
              {fact.value}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{fact.sub}</p>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        <Link
          href="/contribute"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-primary bg-primary/10 px-5 font-mono text-sm font-semibold uppercase tracking-wider text-primary transition-colors motion-reduce:transition-none hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Add a facility · Correct a figure →
        </Link>
      </div>

      {recentActivity.length > 0 && (
        <div className="mt-10">
          <div className="mb-5 flex items-center justify-between gap-4">
            <h3 className="font-display text-lg text-foreground">
              Recently updated
            </h3>
            <Link href="/activity" className={TRAILING_LINK_CLASS}>
              View all →
            </Link>
          </div>
          <ActivityList entries={recentActivity} />
        </div>
      )}
    </section>
  );
}
