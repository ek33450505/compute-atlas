import Link from "next/link";

import { formatLocation } from "@/lib/format";
import type { Facility } from "@/lib/schema";

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
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § Community friction
      </p>
      <h2
        id="contested-heading"
        className="mt-1 font-display text-2xl text-foreground"
      >
        Contested sites
      </h2>
      <p className="mt-3 max-w-2xl text-base text-muted-foreground">
        {frictionCount} tracked sites carry a documented friction status —{" "}
        {breakdown.litigation} in litigation, {breakdown.opposed} opposed,{" "}
        {breakdown.contested} contested — each with a public source.
      </p>
      {cases.length > 0 && (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cases.map((f) => (
            <li key={f.id}>
              <Link
                href={`/facilities/${f.id}`}
                className="neatline group flex h-full flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
