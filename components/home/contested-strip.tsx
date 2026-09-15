import Link from "next/link";

import { formatLocation } from "@/lib/format";
import {
  FRICTION_CAUSES_FINDING,
  FRICTION_ELECTRICITY_CONTRAST,
} from "@/lib/glossary";
import type { Facility } from "@/lib/schema";
import { SectionHeading } from "@/components/section-heading";

interface ContestedStripProps {
  cases: Facility[];
  frictionCount: number;
  breakdown: { litigation: number; opposed: number; contested: number };
  className?: string;
}

export function ContestedStrip({
  cases,
  frictionCount,
  breakdown,
  className,
}: ContestedStripProps) {
  return (
    <section aria-labelledby="contested-heading" className={className}>
      {/* space-y-1 reproduces the `mt-1` the h2 used to carry itself — the
          kicker/h2 gap moves to the wrapper because SectionHeading owns the
          pair and deliberately emits no margin of its own (same shape as
          app/power/page.tsx's `space-y-2` wrapper). */}
      <div className="space-y-1">
        <SectionHeading
          kicker="Community friction"
          id="contested-heading"
          size="lg"
          title="Contested sites"
        />
      </div>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        {frictionCount} tracked sites carry a documented friction status —{" "}
        {breakdown.litigation} in litigation, {breakdown.opposed} opposed,{" "}
        {breakdown.contested} contested — each with a public source.
      </p>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        {FRICTION_CAUSES_FINDING}{" "}
        {FRICTION_ELECTRICITY_CONTRAST} These are specific local
        consequences at a named well or property line, rather than an
        argument about data centers in general. More on{" "}
        <Link
          href="/learn/why-do-communities-oppose-data-centers"
          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          why communities oppose data centers
        </Link>
        .
      </p>
      {cases.length > 0 && (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cases.map((f) => (
            <li key={f.id}>
              <Link
                href={`/facilities/${f.id}`}
                className="neatline plate-hover group flex h-full flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="font-display text-base leading-snug text-foreground transition-colors motion-reduce:transition-none group-hover:text-primary">
                  {f.name}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatLocation(f)}
                </span>
                {f.community?.notes && (
                  <p className="text-xs text-muted-foreground line-clamp-3">
                    {f.community.notes}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <Link
          href="/opposition"
          className="inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          See all contested sites →
        </Link>
      </div>
    </section>
  );
}
