import { StatusBadge } from "@/components/status-badge";
import { STATUS_ORDER } from "@/lib/status";
import { cn } from "@/lib/utils";

interface PlateKeyProps {
  /**
   * Sites the plate draws ground for: `HERO_PLATE.total - HERO_PLATE.omitted`.
   * NOT `HERO_PLATE.plotted` — that counts drawn MARKS, and co-located
   * same-status facilities collapse onto one mark, so it under-counts
   * facilities by design.
   */
  sites: number;
  /** `HERO_PLATE.deduped`: sites drawn on a mark another same-status site already occupies. */
  shared: number;
  /** `HERO_PLATE.omitted`: facilities in U.S. territories the Albers USA plate cannot place. */
  omitted: number;
  /** The snapshot date the plate drew (`HERO_PLATE.asOf`, already formatted, e.g. "11 November 2026"). */
  asOfLabel: string;
  /**
   * PLACEMENT LIVES HERE, not in the component. The card is IN FLOW at every
   * breakpoint: app/page.tsx renders it as a direct child of the hero box's
   * `flex flex-col`, where `sm:mt-auto` absorbs the free space to settle it on
   * the box's bottom edge when there is slack, and leaves it directly under
   * the CTA row when there is not. ⛔ Do NOT re-pin it with `sm:absolute` —
   * that is a recorded overlap regression, and the <PlateKey> call site in
   * app/page.tsx carries the full account. This component deliberately makes
   * no assumption about where it sits, so it owns no positioning, width or
   * elevation classes of its own.
   */
  className?: string;
}

/**
 * The hero dot plate's key: a status legend and a one-line caption.
 *
 * ⚠️ The caption states only what the PLATE drew, dated with the snapshot it
 * drew. It never states the live dataset total: the plate is a build-time
 * artifact and the live count (<HeroProvenance>, from the DB) can be newer, so
 * an undated number here beside a live one read as a contradiction (the audit's
 * 3,145 vs 3,174). The date is what lets both be true. The territory omission
 * lives HERE, beside the plot it qualifies, and nowhere else.
 *
 * ⚠️ This is rendered by app/page.tsx as a SIBLING of the hero's globe/plate
 * box, never inside <HeroPlate>'s <svg> and never inside the `plate` prop
 * handed to <HeroGlobe>. hero-globe-dynamic.tsx swaps that whole node out for
 * an aria-hidden MapLibre canvas once the globe mounts (sm+ only), so anything
 * living in it is present or absent on desktop purely on timing — the same
 * trap that moved the plate's territory disclosure into <HeroProvenance>. A
 * key that disappears at exactly the viewport where the map is richest is not
 * a key. Keep it out here.
 *
 * ⚠️ The container is FULLY OPAQUE `bg-background`, not the `bg-background/85
 * backdrop-blur-sm` its neighbour the methodology link uses. On sm+ the auto
 * margin settles it into the hero box's bottom-left corner, directly ON live
 * MapLibre tiles rather than merely near them — satellite imagery included, where
 * a translucent backing leaves the effective contrast unknown and lower. Every
 * status hue is audited against parchment specifically (globals.css: 5.88:1 to
 * 9.17:1 on #F5F1E6) — an opaque parchment fill is what makes those the ratios
 * that actually apply here, rather than numbers about a backdrop the reader
 * may not have. Do not trade it for a tint.
 *
 * No counts are rendered per status: `HERO_PLATE.counts` are drawn MARKS, not
 * facilities, and captioning them as facility counts is exactly what the
 * artifact's doc comment forbids.
 */
export function PlateKey({ sites, shared, omitted, asOfLabel, className }: PlateKeyProps) {
  return (
    <section
      aria-label="Map key"
      className={cn(
        "rounded-sm border border-border bg-background px-3 py-2.5",
        className,
      )}
    >
      {/*
       * <StatusBadge> is reused rather than reimplemented: it already pairs
       * an aria-hidden lucide icon with the label in the status colour, so
       * each entry encodes its status by SHAPE and TEXT as well as hue. That
       * is the whole fix — the plate's marks are colour-only, and this is
       * the key that decodes them.
       *
       * Two flow directions for one list. Below sm this card is full width in
       * normal flow, where a horizontal wrap uses the line economically (two
       * rows, not five). On sm+ it is a shrink-wrapped corner overlay capped
       * at max-w-xs, and a vertical stack is what a map key looks like — one
       * status per line, scannable against the marks it decodes.
       */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-col sm:items-start sm:gap-y-1.5">
        {STATUS_ORDER.map((status) => (
          <li key={status}>
            <StatusBadge status={status} />
          </li>
        ))}
      </ul>

      {/* Each sentence is ONE template literal (one text node): `{n} sites plotted`
          would render adjacent nodes with React's `<!-- -->` between them in SSR HTML,
          the shape e2e/prose-spacing.spec.ts polices, and getByText reads DIRECT text
          nodes only. Identity (build-checked, hero-plate-paths.ts): total = marks + shared + omitted,
          so the sites shown are total − omitted = marks + shared. `shared` counts sites drawn on a mark
          another same-status site already holds (each mark's first occupant is not in it). */}
      <p className="mt-2.5 font-mono text-xs tabular-nums text-muted-foreground">
        {`${sites.toLocaleString("en-US")} sites plotted as of ${asOfLabel}`}
      </p>
      {(shared > 0 || omitted > 0) && (
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
          {[
            shared > 0
              ? `${shared.toLocaleString("en-US")} ${shared === 1 ? "site is" : "sites are"} drawn on a mark another site already holds.`
              : null,
            omitted > 0
              ? `${omitted.toLocaleString("en-US")} in ${omitted === 1 ? "a U.S. territory is" : "U.S. territories are"} off this map.`
              : null,
          ]
            .filter((part) => part !== null)
            .join(" ")}
        </p>
      )}
    </section>
  );
}
