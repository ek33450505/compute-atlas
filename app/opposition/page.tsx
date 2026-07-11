import Link from "next/link";
import type { Metadata } from "next";

import { getFacilitiesByCommunityStatus, getCommunityReceptionCounts } from "@/lib/data";
import { COMMUNITY_RECEPTION_META, type CommunityReception } from "@/lib/community";
import { formatLocation } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Breadcrumb } from "@/components/breadcrumb";

/** Most-severe-first display order for the friction statuses shown on this page. */
const FRICTION_ORDER = ["litigation", "opposed", "contested"] as const satisfies readonly CommunityReception[];

export const metadata: Metadata = {
  title: "Opposition",
  description:
    "The U.S. compute sites facing documented community friction — litigation, moratoria, referendums, and formal opposition, each with a public source. Part of Compute Atlas.",
};

/**
 * /opposition — index of tracked sites with sourced local friction. Static server component.
 *
 * Surfaces facilities whose community.status is contested, opposed, or in
 * litigation — the subset of the dataset with documented pushback. This is
 * not a claim about the buildout as a whole: non-friction statuses
 * (supported, mixed, unknown) are out of scope for this page. Mirrors the
 * /power and /stats visual language (masthead, survey-stat row, § progress-bar
 * sections, block-Link rows).
 */
export default function OppositionPage() {
  const counts = getCommunityReceptionCounts();
  const groups = FRICTION_ORDER.map((status) => ({
    status,
    facilities: getFacilitiesByCommunityStatus(status),
  }));
  const total = FRICTION_ORDER.reduce((sum, status) => sum + counts[status], 0);
  const statesWithFriction = new Set(
    groups.flatMap((g) => g.facilities.map((f) => f.location.state))
  ).size;

  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Opposition" }]} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          Community friction
        </p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Where the buildout meets resistance
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Tracked sites with documented local friction — lawsuits, moratoria,
          referendums, and formal opposition. This is not a claim about the
          buildout as a whole; it is the sourced subset facing pushback, and
          every entry links to a source-cited record.
        </p>
        <div className="border-t border-border" />
      </header>

      {total === 0 ? (
        <p className="text-base text-muted-foreground">
          No documented community friction is on file yet.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------------------------ */}
          {/* Survey stats row                                                    */}
          {/* ------------------------------------------------------------------ */}
          <div className="flex flex-wrap gap-8 border-b border-border pb-10">
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {total}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Friction sites
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {counts.litigation}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                In litigation
              </span>
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="font-mono tabular-nums text-4xl font-semibold text-foreground">
                {statesWithFriction}
              </span>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                States
              </span>
            </div>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* § By reception                                                      */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="reception-heading"
            className="space-y-6 border-t border-border pt-10"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              § By reception
            </p>
            <h2 id="reception-heading" className="font-display text-2xl text-foreground">
              By reception
            </h2>
            <div className="space-y-4">
              {FRICTION_ORDER.map((status) => {
                const count = counts[status];
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={status} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-foreground">
                        {COMMUNITY_RECEPTION_META[status].label}
                      </span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {count} &middot; {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        aria-hidden="true"
                        className="h-full rounded-full"
                        style={{
                          width: `${pct.toFixed(2)}%`,
                          backgroundColor: "var(--primary)",
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ------------------------------------------------------------------ */}
          {/* § The sites                                                         */}
          {/* ------------------------------------------------------------------ */}
          <section
            aria-labelledby="sites-heading"
            className="space-y-8 border-t border-border pt-10"
          >
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              § The sites
            </p>
            <h2 id="sites-heading" className="font-display text-2xl text-foreground">
              The sites
            </h2>
            <div className="space-y-8">
              {groups.map((group) => (
                <div key={group.status} className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">
                    {COMMUNITY_RECEPTION_META[group.status].label} &middot; {group.facilities.length}
                  </h3>
                  <ul className="divide-y divide-border">
                    {group.facilities.map((f) => (
                      <li key={f.id}>
                        <Link
                          href={`/facilities/${f.id}`}
                          className="flex min-h-11 flex-col gap-1 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                        >
                          <span className="flex items-center justify-between gap-4">
                            <span className="text-sm text-foreground truncate">
                              {f.name}
                            </span>
                            <span className="shrink-0">
                              <StatusBadge status={f.status} />
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {f.operator} &middot; {formatLocation(f)}
                          </span>
                          {f.community?.notes && (
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {f.community.notes}
                            </p>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
