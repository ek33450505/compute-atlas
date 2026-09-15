import { HERO_PLATE } from "@/components/home/hero-plate-paths";
import { STATUS_ORDER, getStatusColor } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * A static, server-rendered Albers USA dot plate of the whole dataset.
 *
 * This is a plain inline <svg> with no client JavaScript — it renders
 * identically on a phone and in the first paint of a desktop load, which is
 * the point. `hero-globe-dynamic.tsx` gates MapLibre to sm+ viewports, so
 * without this plate phones see an abstract CSS graticule and no map at all,
 * and desktop first-paints that same empty grid before the globe arrives.
 * The plate costs zero requests (the path data is a committed build artifact
 * imported at module scope) so it does not weaken that mobile gate.
 *
 * ⚠️ Mechanical contract from components/home/hero-plate-paths.ts: every mark
 * is a ZERO-LENGTH subpath (`M<x> <y>h.01`). It is drawn only by the stroke's
 * round cap, so `stroke-linecap="round"` and a non-zero `stroke-width` are
 * load-bearing, and `fill` draws literally nothing. Dropping any of the three
 * renders a blank plate that looks like a data problem.
 */

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * A mark reads as a dot rather than a blob at hero scale. The viewBox is
 * 1600 units wide and the hero renders it at roughly 700–1400 CSS px, so a
 * 7-unit stroke is a ~3–6 px circle on screen — still visible on a phone,
 * still small enough that adjacent metros stay separable. In map terms the
 * CONUS spans ~1,300 of those units across ~2,800 miles, so 7 units is ~15
 * miles of dot: a plausible site footprint at national scale, not a county.
 */
const MARK_STROKE_WIDTH = 7;

/**
 * Facilities the plate actually draws ground for. NOT `plotted` — that is a
 * count of drawn MARKS, and same-status co-located facilities collapse onto
 * one mark (`deduped`), so `plotted` under-counts facilities by design. The
 * artifact's own doc comment says never to caption marks as facilities.
 */
const COVERED = HERO_PLATE.total - HERO_PLATE.omitted;

/**
 * Deliberately short, and it claims only what the plate DRAWS (`COVERED`,
 * never `HERO_PLATE.total`) — an image's accessible name is announced in full
 * before the reader reaches anything else, and this one sits immediately ahead
 * of the page's H1.
 *
 * ⚠️ The territory omission is NOT disclosed here any more, and re-adding it
 * would not fix what it looks like it fixes: this element only exists until
 * MapLibre mounts (hero-globe-dynamic.tsx swaps the plate out for the globe,
 * which is aria-hidden), so on desktop the disclosure was announced or not
 * purely on timing. It now lives in the always-present provenance rule
 * (components/home/hero-provenance.tsx, `mapOmitted`), which no viewport or
 * mount order can take away. It is disclosed there as a COUNT ("static map
 * omits 9 in U.S. territories"); the omitted jurisdictions' individual NAMES
 * are no longer rendered anywhere, having been cut from the plate's caption
 * (components/home/plate-key.tsx) as prose the fold did not need. That is a
 * loss of four names, not of the fact — and it is not an argument for moving
 * the disclosure back into this name, which the paragraph above rules out on
 * grounds the deletion does not touch.
 */
const ACCESSIBLE_NAME = `Dot map of ${NUMBER.format(
  COVERED
)} tracked sites, coloured by project status.`;

/**
 * The colour-only-encoding gap the name above used to leave open is CLOSED:
 * the key (status legend + caption) is components/home/plate-key.tsx,
 * rendered by app/page.tsx.
 *
 * ⚠️ It is rendered there as a persistent SIBLING, not inside this <svg> and
 * not inside the `plate` prop — hero-globe-dynamic.tsx swaps this whole node
 * out for the aria-hidden globe canvas on sm+ once MapLibre mounts, so a key
 * placed in it would disappear at exactly the viewports where the map is
 * richest. Do not "tidy" it in here.
 *
 * ⚠️ And the colour claim in the name above stays. Deleting it would make the
 * name agree with a page that had no key, which is the wrong direction — the
 * plate really is coloured by status, and the key is what earns the claim.
 */

interface HeroPlateProps {
  className?: string;
}

export function HeroPlate({ className }: HeroPlateProps) {
  return (
    <svg
      viewBox={HERO_PLATE.viewBox}
      /**
       * `meet` (letterbox), never `slice` (cover) — this is correctness, not
       * styling. What sits at the edges of this viewBox is the Alaska inset
       * (around x 254–257, y 701–800) and the Hawaii inset (around x 567–634,
       * y 833–876). `slice` crops to fill, so on any container whose aspect
       * ratio is wider or taller than 1600×1000 it would silently drop real
       * facilities while the accessible name below still claims them.
       * Letterboxing is the honest trade.
       */
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ACCESSIBLE_NAME}
      className={cn("h-full w-full", className)}
    >
      {/*
       * Painted in STATUS_ORDER, so later statuses overdraw earlier ones
       * wherever two different statuses land on the same mark (122 such
       * cross-status overplots in the current snapshot). Deterministic rather
       * than arbitrary: the plate is a density backdrop, not a per-site
       * lookup, and this is the order the status legend uses everywhere else.
       */}
      {STATUS_ORDER.map((status) => (
        <path
          key={status}
          d={HERO_PLATE.paths[status]}
          fill="none"
          stroke={getStatusColor(status)}
          strokeWidth={MARK_STROKE_WIDTH}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
