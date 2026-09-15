import { StatusBadge } from "@/components/status-badge";
import { STATUS_ORDER } from "@/lib/status";
import { cn } from "@/lib/utils";

interface PlateKeyProps {
  /**
   * Facilities the plate draws ground for: `HERO_PLATE.total - HERO_PLATE.omitted`.
   * NOT `HERO_PLATE.plotted` — that counts drawn MARKS, and co-located
   * same-status facilities collapse onto one mark, so it under-counts
   * facilities by design.
   */
  plotted: number;
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
 * ⚠️ ONE number, deliberately. The caption states only what the PLATE drew,
 * which is a property of the build-time artifact. The live dataset total is
 * <HeroProvenance>'s job and is stated there exactly once, from Neon. A
 * caption reading "1,920 of 1,929" put a snapshot total a few lines under a
 * live one — each honest alone, contradictory as a pair the moment a data
 * sync lands without a plate rebuild. Do not reintroduce a second total here.
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
export function PlateKey({ plotted, className }: PlateKeyProps) {
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

      {/* One number, one text node, no separators.

          ⚠️ The territory disclosure was NOT dropped when the names came out
          of this caption. <HeroProvenance> renders "static map omits N in
          U.S. territories" from its `mapOmitted` prop — durable visible text
          at every viewport and every mount state, and the load-bearing
          disclosure. What disappeared here is only the four jurisdiction
          NAMES, which were prose, not the fact. Do not "restore" them.

          Built as ONE template literal rather than `{n} sites plotted`, which
          would render two adjacent text nodes with React's `<!-- -->` between
          them in SSR HTML — the shape e2e/prose-spacing.spec.ts exists to
          police. A single expression also keeps it matching <HeroProvenance>'s
          treatment: split across nodes it would be harder to reach with a
          plain getByText, which reads DIRECT text nodes only. */}
      <p className="mt-2.5 font-mono text-xs tabular-nums text-muted-foreground">
        {`${plotted.toLocaleString("en-US")} sites plotted`}
      </p>
    </section>
  );
}
