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
 * mount order can take away. The omitted jurisdictions' NAMES are deferred to
 * the plate's caption in the next unit — the provenance rule is one line above
 * the fold and four territory names would not fit it.
 */
const ACCESSIBLE_NAME = `Dot map of ${NUMBER.format(
  COVERED
)} tracked sites, coloured by project status.`;

/**
 * ⚠️ KNOWN GAP, DEFERRED ON PURPOSE — not an oversight. The name above says
 * "coloured by project status" while the page carries no legend, so status is
 * currently colour-ONLY encoding with no key: a reader who cannot resolve the
 * five hues has no way to decode the plate. The legend, caption and corner
 * link are the next unit's scope; this comment exists so the gap is not
 * re-discovered as a fresh finding, and so it is not closed by quietly
 * deleting the colour claim from the name instead.
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
