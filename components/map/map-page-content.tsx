import Link from "next/link";

import type { getStats, getTopStates, getTopOperators } from "@/lib/data";
import { operatorSlug } from "@/lib/data";
import { stateNameFromCode, stateSlugFromCode, statesPhrase } from "@/lib/us-states";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META, type FacilityType } from "@/lib/facility-type";
import { SectionHeading } from "@/components/section-heading";

export interface MapPageContentProps {
  stats: Pick<Awaited<ReturnType<typeof getStats>>, "count" | "stateCodes">;
  topStates: Awaited<ReturnType<typeof getTopStates>>;
  topOperators: Awaited<ReturnType<typeof getTopOperators>>;
  statusCounts: Record<Status, number>;
  typeCounts: Record<FacilityType, number>;
}

/**
 * Facility types with a dedicated landing page to link to. `data_center` has
 * no standalone hub route (the site's default lens is already
 * data-center-first), so it renders as plain text below rather than a dead
 * or invented link.
 */
const FACILITY_TYPE_HREF: Partial<Record<FacilityType, string>> = {
  crypto_mining: "/crypto",
  power_generation: "/power",
};

const rowLinkClass =
  "flex min-h-11 items-center justify-between gap-4 py-2 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";
const rowStaticClass = "flex min-h-11 items-center justify-between gap-4 py-2 text-sm";

/** "N facility" / "N facilities" — shared by the visible count text and the `aria-label`s below so the two can never drift apart. */
function facilityCountPhrase(count: number): string {
  return `${count} ${count === 1 ? "facility" : "facilities"}`;
}

/**
 * Visible layout puts the label and count in separate flex children with no
 * text between them, so the accessible-name algorithm concatenates them with
 * no separator at all — "Virginia" + "143 facilities" reads as
 * "Virginia143 facilities" to a screen reader even though `justify-between`
 * shows a comfortable gap on screen. Rows that are links use an explicit
 * `aria-label` (below) instead of this, because the accessible-name
 * algorithm trims whitespace at each element's own boundary before
 * concatenating — a sibling `sr-only` span containing ", " gets trimmed
 * back down to a bare "," (no space) once joined, which an `aria-label`
 * sidesteps entirely by supplying the whole phrase pre-formed. This
 * component stays only for the two non-interactive rows (a state with no
 * resolvable slug, and the unlinked `data_center` facility-type row): they
 * have no computed "name" to override, so a real, if visually hidden, text
 * node is still what makes a screen reader pause between the two halves
 * when reading the row as flowing text. Same JSX-whitespace family as the
 * leading-space-after-entity bug elsewhere in this repo: correct on screen,
 * wrong for assistive tech, invisible in code review.
 */
function NameSeparator() {
  return <span className="sr-only">, </span>;
}

/**
 * Server-rendered, visible content block for /map, appended below the
 * (client-only, canvas-painted) Explorer map shell.
 *
 * The map itself has no crawlable text — MapLibre paints into a canvas and
 * Explorer is a client component — so /map previously shipped ~150 chars of
 * site chrome and no <h1>, and ranked ~80th for every head-term query despite
 * being Google's picked result. This section gives the page real prose plus
 * links into the state/operator/status hubs that already carry the map's
 * underlying data server-side. Presentational only — callers (app/map/page.tsx)
 * own data fetching, so this stays testable without mocking the data layer
 * (mirrors components/collection/collection-page.tsx).
 */
export function MapPageContent({
  stats,
  topStates,
  topOperators,
  statusCounts,
  typeCounts,
}: MapPageContentProps) {
  const stateRows = topStates.map((s) => ({
    ...s,
    name: stateNameFromCode(s.state) ?? s.state,
    slug: stateSlugFromCode(s.state),
  }));

  const statusRows = STATUS_ORDER.filter((s) => statusCounts[s] > 0).map((s) => ({
    status: s,
    label: STATUS_META[s].label,
    count: statusCounts[s],
  }));

  const typeRows = FACILITY_TYPE_ORDER.filter((t) => typeCounts[t] > 0).map((t) => ({
    type: t,
    label: FACILITY_TYPE_META[t].label,
    count: typeCounts[t],
    href: FACILITY_TYPE_HREF[t],
  }));

  return (
    <section
      aria-labelledby="map-content-heading"
      className="mx-auto max-w-6xl space-y-8 px-4 py-12 sm:px-6"
    >
      <div className="space-y-2">
        <SectionHeading
          kicker="On this map"
          id="map-content-heading"
          title="What the map shows"
        />
      </div>

      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
        The map plots all {stats.count.toLocaleString("en-US")} tracked sites
        across {statesPhrase(stats.stateCodes)} — traditional and AI-specific
        data centers, crypto-mining operations, and the dedicated power
        generation built to supply them — each pin backed by a cited source.
        Use the panel on the map to filter by status, state, operator, or
        capacity, or jump straight to a jurisdiction, operator, or category
        below.
      </p>

      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-display text-lg text-foreground">
            Top states by facility count
          </h3>
          <ul className="divide-y divide-border">
            {stateRows.map((s) => (
              <li key={s.state}>
                {s.slug ? (
                  <Link
                    href={`/states/${s.slug}`}
                    className={rowLinkClass}
                    aria-label={`${s.name}, ${facilityCountPhrase(s.count)}`}
                  >
                    <span className="truncate text-foreground" aria-hidden="true">
                      {s.name}
                    </span>
                    <span
                      className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground"
                      aria-hidden="true"
                    >
                      {facilityCountPhrase(s.count)}
                    </span>
                  </Link>
                ) : (
                  <div className={rowStaticClass}>
                    <span className="truncate text-foreground">{s.name}</span>
                    <NameSeparator />
                    <span className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground">
                      {facilityCountPhrase(s.count)}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <h3 className="font-display text-lg text-foreground">
            Top operators by facility count
          </h3>
          <ul className="divide-y divide-border">
            {topOperators.map((o) => (
              <li key={o.operator}>
                <Link
                  href={`/operators/${operatorSlug(o.operator)}`}
                  className={rowLinkClass}
                  aria-label={`${o.operator}, ${facilityCountPhrase(o.count)}`}
                >
                  <span className="truncate text-foreground" aria-hidden="true">
                    {o.operator}
                  </span>
                  <span
                    className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground"
                    aria-hidden="true"
                  >
                    {facilityCountPhrase(o.count)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-display text-lg text-foreground">By status</h3>
          <ul className="divide-y divide-border">
            {statusRows.map((s) => (
              <li key={s.status}>
                <Link
                  href={`/status/${s.status}`}
                  className={rowLinkClass}
                  aria-label={`${s.label}, ${facilityCountPhrase(s.count)}`}
                >
                  <span className="truncate text-foreground" aria-hidden="true">
                    {s.label}
                  </span>
                  <span
                    className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground"
                    aria-hidden="true"
                  >
                    {facilityCountPhrase(s.count)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <h3 className="font-display text-lg text-foreground">
            By facility type
          </h3>
          <ul className="divide-y divide-border">
            {typeRows.map((t) =>
              t.href ? (
                <li key={t.type}>
                  <Link
                    href={t.href}
                    className={rowLinkClass}
                    aria-label={`${t.label}, ${facilityCountPhrase(t.count)}`}
                  >
                    <span className="truncate text-foreground" aria-hidden="true">
                      {t.label}
                    </span>
                    <span
                      className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground"
                      aria-hidden="true"
                    >
                      {facilityCountPhrase(t.count)}
                    </span>
                  </Link>
                </li>
              ) : (
                <li key={t.type} className={rowStaticClass}>
                  <span className="truncate text-foreground">{t.label}</span>
                  <NameSeparator />
                  <span className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground">
                    {facilityCountPhrase(t.count)}
                  </span>
                </li>
              )
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
