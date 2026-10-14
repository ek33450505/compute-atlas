#!/usr/bin/env node
/**
 * build-hero-plate.mjs
 *
 * Build-time generator for the homepage hero "plate": a static, inline-SVG
 * dot-density map of every tracked facility, projected through Albers USA.
 *
 * Why this exists: the hero's MapLibre globe is gated to `sm+` viewports, so
 * phones download no map at all. The plate is the alternative that works on
 * every viewport with zero client JS — one `<path>` per status, using the
 * zero-length-subpath dot trick (`M<x> <y>h.01` + `stroke-linecap="round"`),
 * which collapses ~1.9k marks into 5 DOM nodes and a few KB of markup.
 *
 * Output (committed):
 *   components/home/hero-plate-paths.ts
 *   docs/media/map.svg   (standalone README map; same marks, parchment ground,
 *                         legend and as-of line; see buildReadmeSvg)
 *
 * A typed TS module rather than a raw .svg on purpose: it is tree-shakeable,
 * diffable in review, and unit-testable. A .svg is none of those.
 *
 * Runs as part of `npm run build:mapdata` (including under --skip-nhd, since
 * it does no network I/O) and standalone via `npm run build:heroplate`.
 *
 * Usage: node scripts/build-hero-plate.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { mesh } from 'topojson-client';
import { presimplify, simplify } from 'topojson-simplify';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const FACILITIES_PATH = resolve(repoRoot, 'data/facilities.json');
const META_PATH = resolve(repoRoot, 'data/facilities.meta.json');
const OUT_PATH = resolve(repoRoot, 'components/home/hero-plate-paths.ts');
const TOPOLOGY_PATH = resolve(repoRoot, 'node_modules/us-atlas/states-10m.json');
const SVG_OUT_PATH = resolve(repoRoot, 'docs/media/map.svg');

/**
 * Plate geometry. The aspect ratio is 8:5, matching the 960x600 framing the
 * projection's anchors were verified against — keeping the ratio means every
 * verified anchor scales by exactly WIDTH/960 in BOTH axes, so the anchor set
 * remains a usable regression oracle at any width. Changing the ratio alone
 * would silently invalidate it.
 */
export const WIDTH = 1600;
export const HEIGHT = 1000;

/**
 * The five `Status` values, in `lib/status.ts`'s STATUS_ORDER. Duplicated here
 * rather than imported because this is a plain .mjs build script and
 * lib/status.ts pulls in lucide-react.
 *
 * What actually catches a drift, per kind:
 * - ADD or RENAME in lib/status.ts -> caught at typecheck, because the
 *   generated module is `as const satisfies HeroPlate` over
 *   `Record<Status, ...>`; a missing or unknown key fails to satisfy it.
 * - REORDER -> NOT caught by that, because the order of a Record's keys is not
 *   part of its type. It is caught only by the STATUS_ORDER equality test in
 *   build-hero-plate.test.ts, which imports lib/status.ts directly.
 *
 * Order is load-bearing: it is the order the consumer paints the <path>s in,
 * so a silent reorder changes which status draws on top of which.
 *
 * (`buildPlateData` separately throws on any status outside this list, which
 * catches a rename at build time but says nothing about order.)
 */
export const STATUS_ORDER = [
  'operational',
  'under_construction',
  'permitted',
  'proposed',
  'cancelled',
];

/**
 * Jurisdictions that exist in the dataset but cannot be drawn in an Albers USA
 * framing: GU/MP sit near +145 deg longitude in the western Pacific, PR/VI
 * land just outside the east edge of the CONUS box. They are omitted from the
 * plate and REPORTED, never silently dropped — the component captions the
 * omission. Mirrors `US_TERRITORY_NAMES` in lib/us-states.ts.
 */
export const OMITTED_JURISDICTIONS = new Set(['AS', 'GU', 'MP', 'PR', 'VI']);

// ---------------------------------------------------------------------------
// Projection — ported verbatim from a verified reference. Do not re-derive.
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;

function conicEqualAreaRaw(phi0Deg, phi1Deg, phi2Deg) {
  const sy0 = Math.sin(phi1Deg * RAD);
  const n = (sy0 + Math.sin(phi2Deg * RAD)) / 2;
  const C = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(C - 2 * n * Math.sin(phi0Deg * RAD)) / n;
  return (lambdaDeg, phiDeg) => {
    const r = Math.sqrt(C - 2 * n * Math.sin(phiDeg * RAD)) / n;
    const t = n * lambdaDeg * RAD;
    return [r * Math.sin(t), r0 - r * Math.cos(t)];
  };
}

/**
 * ⚠️ The y negation below is LOAD-BEARING. The standard Albers formula returns
 * NORTH-POSITIVE y (math convention); screen space is south-positive. d3
 * applies this flip inside its scaleTranslate step, so a naive port of only
 * conicEqualAreaRaw renders the map upside down — Seattle below Miami. That
 * was the first bug hit porting this; do not "simplify" the minus sign away.
 * Pinned by an explicit y-orientation test in build-hero-plate.test.ts.
 */
export function makeAlbers({ scale, translate, rotate, center, parallels, phi0 }) {
  const raw = conicEqualAreaRaw(phi0, parallels[0], parallels[1]);
  const ctr = raw(center[0], center[1]);
  return ([lon, lat]) => {
    const q = raw(lon + rotate, lat);
    return [
      translate[0] + scale * (q[0] - ctr[0]),
      translate[1] - scale * (q[1] - ctr[1]), // <-- see warning above
    ];
  };
}

/**
 * Albers USA for a WIDTH x HEIGHT viewBox: CONUS conic plus AK and HI insets.
 *
 * Returns `(lon, lat, stateCode) => [x, y] | null`, where `null` means the
 * jurisdiction is not representable in this framing.
 *
 * ⚠️ Dispatch is by JURISDICTION CODE, never by lat/lon range. Guam and Saipan
 * are at roughly +145 deg longitude, so any longitude-window guess ("west of
 * -130 is Alaska/Hawaii") misroutes them into the middle of an inset.
 */
export function makeAlbersUsa(width = WIDTH, height = HEIGHT) {
  const S = 1070 * (width / 960);
  const conus = makeAlbers({
    scale: S,
    translate: [width / 2, height / 2 - 40 * (height / 600)],
    rotate: 96,
    center: [-0.6, 38.7],
    parallels: [29.5, 45.5],
    phi0: 38.7,
  });
  const alaska = makeAlbers({
    scale: 0.35 * S,
    translate: [width * 0.14, height * 0.83],
    rotate: 154,
    center: [-2, 58.5],
    parallels: [55, 65],
    phi0: 58.5,
  });
  const hawaii = makeAlbers({
    scale: S,
    translate: [width * 0.32, height * 0.88],
    rotate: 157,
    center: [-3, 19.9],
    parallels: [8, 18],
    phi0: 19.9,
  });
  return (lon, lat, stateCode) => {
    if (stateCode === 'AK') return alaska([lon, lat]);
    if (stateCode === 'HI') return hawaii([lon, lat]);
    if (OMITTED_JURISDICTIONS.has(stateCode)) return null;
    return conus([lon, lat]);
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`build-hero-plate: cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`build-hero-plate: ${label} is not valid JSON: ${err.message}`);
  }
}

/**
 * Project every facility and fold same-status co-located marks together.
 *
 * Pure (takes the facility array, touches no filesystem) so the tests can feed
 * it adversarial fixtures — an out-of-bounds point, an unknown jurisdiction —
 * without writing a file.
 *
 * @returns {{ paths: Record<string,string>, counts: Record<string,number>,
 *   plotted: number, deduped: number, omitted: number,
 *   omittedJurisdictions: string[], total: number }}
 */
export function buildPlateData(facilities, width = WIDTH, height = HEIGHT) {
  if (!Array.isArray(facilities)) {
    throw new Error(
      `build-hero-plate: expected an array of facilities, got ${typeof facilities}`
    );
  }

  const project = makeAlbersUsa(width, height);
  /** status -> Set of "x,y" keys (the dedupe) */
  const seen = new Map(STATUS_ORDER.map((s) => [s, new Set()]));
  /** status -> [x, y][] in insertion order, deduped */
  const marks = new Map(STATUS_ORDER.map((s) => [s, []]));

  const omittedCodes = new Set();
  let omitted = 0;
  let deduped = 0;

  for (const facility of facilities) {
    const id = facility?.id ?? '<unknown id>';
    const lat = facility?.location?.lat;
    const lon = facility?.location?.lon;
    const state = facility?.location?.state;
    const status = facility?.status;

    if (!STATUS_ORDER.includes(status)) {
      throw new Error(
        `build-hero-plate: facility ${id} has unrecognized status ${JSON.stringify(status)} — expected one of ${STATUS_ORDER.join(', ')}`
      );
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(
        `build-hero-plate: facility ${id} has non-finite coordinates (lat=${lat}, lon=${lon}) — refusing to plot a map with a hole in it`
      );
    }
    if (typeof state !== 'string' || state.length !== 2) {
      throw new Error(
        `build-hero-plate: facility ${id} has no usable location.state (${JSON.stringify(state)}) — dispatch is by jurisdiction code, so a missing code cannot be guessed from lat/lon`
      );
    }

    const code = state.toUpperCase();
    if (OMITTED_JURISDICTIONS.has(code)) {
      omitted += 1;
      omittedCodes.add(code);
      continue;
    }

    const projected = project(lon, lat, code);
    if (projected === null) {
      // Unreachable while OMITTED_JURISDICTIONS is the only null path, but a
      // silent skip here is exactly the failure this file exists to prevent.
      throw new Error(
        `build-hero-plate: facility ${id} (${code}) projected to null but is not a known omitted jurisdiction`
      );
    }

    const [rawX, rawY] = projected;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      throw new Error(
        `build-hero-plate: facility ${id} (${code}, ${lat}, ${lon}) projected to a non-finite point [${rawX}, ${rawY}]`
      );
    }

    const x = Math.round(rawX);
    const y = Math.round(rawY);
    if (x < 0 || x > width || y < 0 || y > height) {
      // A silently-clipped map is the failure mode this guard exists to catch:
      // the plate would still render, just missing points, with no error
      // anywhere. If this fires, the projection or the framing broke.
      throw new Error(
        `build-hero-plate: facility ${id} (${code}, ${lat}, ${lon}) projected to [${x}, ${y}], outside the ${width}x${height} viewBox — the projection or framing is broken; a clipped plate must never ship silently`
      );
    }

    const key = `${x},${y}`;
    const statusSeen = seen.get(status);
    if (statusSeen.has(key)) {
      // Same status, same integer pixel: it would overplot identically.
      deduped += 1;
      continue;
    }
    statusSeen.add(key);
    marks.get(status).push([x, y]);
  }

  const paths = {};
  const counts = {};
  let plotted = 0;
  for (const status of STATUS_ORDER) {
    // Sorted so a single added facility produces a local diff instead of
    // shifting every subsequent mark, and so the output is deterministic
    // regardless of the input file's row order.
    const points = marks.get(status).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    paths[status] = points.map(([x, y]) => `M${x} ${y}h.01`).join('');
    counts[status] = points.length;
    plotted += points.length;
  }

  return {
    paths,
    counts,
    plotted,
    deduped,
    omitted,
    omittedJurisdictions: [...omittedCodes].sort(),
    total: facilities.length,
  };
}

/** Serialize the plate data as a typed TS module. */
export function renderModule(data, asOf, width = WIDTH, height = HEIGHT) {
  const pathEntries = STATUS_ORDER.map(
    (s) => `    ${s}:\n      "${data.paths[s]}",`
  ).join('\n');
  const countEntries = STATUS_ORDER.map((s) => `    ${s}: ${data.counts[s]},`).join('\n');
  const outlines = data.outlines ?? { nation: '', borders: '' };
  const omittedList = data.omittedJurisdictions.map((c) => `"${c}"`).join(', ');

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Produced by scripts/build-hero-plate.mjs; regenerate with
// \`npm run build:heroplate\` (or \`npm run build:mapdata\`, which runs it).
//
// A static Albers USA dot-density plate of every tracked facility, as one SVG
// path per status. Each mark is a zero-length subpath (\`M<x> <y>h.01\`), so the
// consumer MUST render these with \`stroke-linecap="round"\` and a non-zero
// \`stroke-width\` — with \`fill\`, they draw nothing.

import type { Status } from "@/lib/status";

export interface HeroPlate {
  /** SVG viewBox for the whole plate, including the AK and HI insets. */
  readonly viewBox: string;
  readonly width: number;
  readonly height: number;
  /** \`d\` attribute per status. Render each as its own <path>. */
  readonly paths: Readonly<Record<Status, string>>;
  /**
   * Drawn MARKS per status — not facility counts. Co-located same-status
   * facilities collapse to one mark (see \`deduped\`), so these under-count
   * facilities by design. Never caption these as "facilities".
   */
  readonly counts: Readonly<Record<Status, number>>;
  /** Total drawn marks: \`Object.values(counts)\` summed. NOT a facility count. */
  readonly plotted: number;
  /** Facilities that landed on a mark another same-status facility already occupied. */
  readonly deduped: number;
  /**
   * Facilities in jurisdictions Albers USA cannot represent (see
   * \`omittedJurisdictions\`). Caption this; do not hide it.
   */
  readonly omitted: number;
  /** Sorted jurisdiction codes behind \`omitted\`, e.g. ["GU","MP","PR","VI"]. */
  readonly omittedJurisdictions: readonly string[];
  /** Facilities read from data/facilities.json: plotted + deduped + omitted. */
  readonly total: number;
  /**
   * Faint Census boundary linework beneath the marks, in the same plate
   * coordinates. Stroke-only paths of relative \`l\` deltas; NOT marks.
   * \`nation\` = coast and national border, \`borders\` = shared state borders.
   */
  readonly outlines: { readonly nation: string; readonly borders: string };
  /** \`asOf\` from data/facilities.meta.json — the snapshot this plate drew. */
  readonly asOf: string;
}

export const HERO_PLATE = {
  viewBox: "0 0 ${width} ${height}",
  width: ${width},
  height: ${height},
  paths: {
${pathEntries}
  },
  counts: {
${countEntries}
  },
  plotted: ${data.plotted},
  deduped: ${data.deduped},
  omitted: ${data.omitted},
  omittedJurisdictions: [${omittedList}],
  total: ${data.total},
  outlines: {
    nation:
      "${outlines.nation}",
    borders:
      "${outlines.borders}",
  },
  asOf: "${asOf}",
} as const satisfies HeroPlate;
`;
}

// ---------------------------------------------------------------------------
// Outlines — faint nation + state-border linework under the dots
// ---------------------------------------------------------------------------

/**
 * Census cartographic boundaries (us-atlas, unprojected lon/lat), projected
 * through the SAME makeAlbersUsa the dots use, so outlines and marks align
 * exactly, AK and HI insets included. Build-time only: us-atlas, topojson-client
 * and topojson-simplify are devDependencies and nothing in app code imports them.
 *
 * Size is a hard constraint (the plate is inlined into every homepage HTML
 * response; outline data targets <= ~15 KB): lines are simplified with
 * topojson-simplify BEFORE projecting, rounded to integers, de-duplicated and written as relative `l` deltas.
 */
// topojson-simplify weight threshold (its own spherical-triangle-area unit, NOT
// plain steradians): measured 0.004 -> 16.0 KB, 0.006 -> 13.0 KB of path data.
export const OUTLINE_MIN_WEIGHT = 0.005;

/** Hard byte budget for `nation` + `borders` path data (homepage inlines it). */
export const OUTLINE_BYTE_BUDGET = 15_500;

/** FIPS of the states drawn with an inset projection; territories are omitted. */
const FIPS_AK = '02';
const FIPS_HI = '15';
const TERRITORY_FIPS = new Set(['60', '66', '69', '72', '78']);

function encodeLines(lines, project, width, height) {
  let out = '';
  for (const line of lines) {
    const pts = [];
    for (const [lon, lat, jurisdiction] of line) {
      const projected = project(lon, lat, jurisdiction);
      if (projected === null) continue;
      const x = Math.round(projected[0]);
      const y = Math.round(projected[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`build-hero-plate: outline point [${lon}, ${lat}] projected to a non-finite point`);
      }
      if (x < 0 || x > width || y < 0 || y > height) {
        throw new Error(
          `build-hero-plate: outline point [${lon}, ${lat}] (${jurisdiction}) projected to [${x}, ${y}], outside the ${width}x${height} viewBox`
        );
      }
      const last = pts[pts.length - 1];
      if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
    }
    if (pts.length < 2) continue;
    let d = `M${pts[0][0]} ${pts[0][1]}l`;
    let prev = pts[0];
    for (let i = 1; i < pts.length; i++) {
      for (const tok of [pts[i][0] - prev[0], pts[i][1] - prev[1]].map(String)) {
        d += tok.startsWith('-') || d.endsWith('l') ? tok : ` ${tok}`;
      }
      prev = pts[i];
    }
    out += d;
  }
  return out;
}

/**
 * Pure: takes a TopoJSON topology of states (us-atlas `states-10m.json` shape),
 * returns `{ nation, borders }` path-data strings in plate coordinates.
 * `nation` = exterior edges (coast + national border); `borders` = edges shared
 * by two states (CONUS only, so they need no inset dispatch).
 */
export function buildOutlines(topology, width = WIDTH, height = HEIGHT, minWeight = OUTLINE_MIN_WEIGHT) {
  const topo = simplify(presimplify(topology), minWeight);
  const states = topo.objects.states;
  const project = makeAlbersUsa(width, height);
  const tag = (mp, jurisdiction, shiftAleutians) =>
    mp.coordinates.map((line) =>
      line.map(([lon, lat]) => [shiftAleutians && lon > 0 ? lon - 360 : lon, lat, jurisdiction])
    );

  const conusIds = states.geometries
    .map((g) => String(g.id).padStart(2, '0'))
    .filter((id) => id !== FIPS_AK && id !== FIPS_HI && !TERRITORY_FIPS.has(id));
  const idOf = (g) => String(g.id).padStart(2, '0');
  const exterior = (ids) => mesh(topo, states, (a, b) => a === b && ids.includes(idOf(a)));

  const nationLines = [
    ...tag(exterior(conusIds), 'XX', false),
    ...tag(exterior([FIPS_AK]), 'AK', true),
    ...tag(exterior([FIPS_HI]), 'HI', false),
  ];
  const interior = mesh(
    topo,
    states,
    (a, b) => a !== b && conusIds.includes(idOf(a)) && conusIds.includes(idOf(b))
  );
  return {
    nation: encodeLines(nationLines, project, width, height),
    borders: encodeLines(tag(interior, 'XX', false), project, width, height),
  };
}

export function loadOutlines(width = WIDTH, height = HEIGHT) {
  return buildOutlines(readJson(TOPOLOGY_PATH, TOPOLOGY_PATH), width, height);
}

// ---------------------------------------------------------------------------
// README SVG
// ---------------------------------------------------------------------------

/**
 * Status colours and labels, duplicated from app/globals.css :root --status-*
 * and lib/status.ts (a plain .mjs script cannot import either). The colours
 * are pinned against globals.css by build-hero-plate.test.ts; the labels are
 * pinned against lib/status.ts there too.
 */
export const STATUS_STYLE = {
  operational: { color: '#005E90', label: 'Operational' },
  under_construction: { color: '#8F4108', label: 'Under construction' },
  permitted: { color: '#036A4A', label: 'Permitted' },
  proposed: { color: '#8A2661', label: 'Proposed' },
  cancelled: { color: '#39414A', label: 'Cancelled' },
};

// Parchment / ink tokens (app/globals.css --background / lib/og-theme.tsx).
const SVG_BG = '#F5F1E6';
const SVG_INK = '#2B2721';
const SVG_MUTED_INK = '#5C5344';
const SVG_MARK_STROKE_WIDTH = 7; // same as components/home/hero-plate.tsx
const SVG_FOOTER_HEIGHT = 100;
/** Lowest plate y worth drawing in the README crop (HI marks end ~y 891). */
export const README_PLATE_HEIGHT = 920;

/**
 * Standalone, GitHub-safe SVG of the plate: attributes only (no script, no
 * foreignObject, no CSS variables, no webfonts). Pure and deterministic: the
 * only date is the dataset's `asOf`. Deliberately prints NO count — `counts`
 * are drawn marks and under-count facilities by design.
 */
export function buildReadmeSvg(data, asOf, width = WIDTH, height = HEIGHT) {
  assertUsableAsOf(asOf, 'buildReadmeSvg asOf');
  const day = asOf.slice(0, 10);
  // Crop the empty band under the AK/HI insets; the footer sits right below.
  const plateHeight = Math.min(height, README_PLATE_HEIGHT);
  const totalHeight = plateHeight + SVG_FOOTER_HEIGHT;
  const baseY = plateHeight + 58;
  const title = 'Compute Atlas: map of tracked US AI data centers, crypto-mining sites and power generation';
  const desc = `Dot map of tracked facilities across the United States, with Alaska and Hawaii insets, coloured by project status. Dataset as of ${day}.`;

  const outlines = data.outlines
    ? `  <g fill="none" stroke="${SVG_MUTED_INK}" stroke-linejoin="round" stroke-linecap="round">
    <path d="${data.outlines.borders}" stroke-opacity=".28" stroke-width="1.5"/>
    <path d="${data.outlines.nation}" stroke-opacity=".5" stroke-width="1.75"/>
  </g>
`
    : '';
  const paths = STATUS_ORDER.map(
    (s) =>
      `  <path d="${data.paths[s]}" fill="none" stroke="${STATUS_STYLE[s].color}" stroke-width="${SVG_MARK_STROKE_WIDTH}" stroke-linecap="round"/>`
  ).join('\n');

  let x = 48;
  const legend = STATUS_ORDER.map((s) => {
    const { color, label } = STATUS_STYLE[s];
    const item = `  <circle cx="${x + 8}" cy="${baseY - 7}" r="8" fill="${color}"/>\n  <text x="${x + 26}" y="${baseY}" font-family="Georgia, serif" font-size="24" fill="${SVG_INK}">${label}</text>`;
    x += 26 + Math.round(label.length * 12.5) + 36;
    return item;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${width} ${totalHeight}" width="${width}" height="${totalHeight}">
  <title>${title}</title>
  <desc>${desc}</desc>
  <rect width="${width}" height="${totalHeight}" fill="${SVG_BG}"/>
${outlines}${paths}
  <line x1="48" y1="${plateHeight + 16}" x2="${width - 48}" y2="${plateHeight + 16}" stroke="${SVG_MUTED_INK}" stroke-opacity=".35" stroke-width="2"/>
${legend}
  <text x="${width - 48}" y="${baseY}" text-anchor="end" font-family="Georgia, serif" font-size="24" fill="${SVG_MUTED_INK}">compute-atlas.com \u00b7 data as of ${day}</text>
</svg>
`;
}

/**
 * `asOf` is written verbatim into a double-quoted TS string literal by
 * `renderModule`, so a value carrying a `"`, a backslash or a newline emits a
 * generated module that does not parse — while the generator still exits 0, so
 * the failure surfaces much later as a TS error pointing at a file nobody
 * hand-wrote. Requiring a real ISO-8601 instant rejects that at the source.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Fail loudly on an unusable `asOf`, at the guard rather than by escaping at
 * the interpolation site — a corrupt meta file is a thing to fix, not to encode
 * faithfully into the artifact.
 */
export function assertUsableAsOf(asOf, source = META_PATH) {
  if (typeof asOf !== 'string' || !ISO_INSTANT.test(asOf)) {
    throw new Error(
      `build-hero-plate: ${source} has no usable \`asOf\` (${JSON.stringify(asOf)}) — the plate must be able to state which snapshot it drew, and the value is emitted verbatim into a TS string literal, so it must be an ISO-8601 instant like 2026-09-15T12:00:00.000Z`
    );
  }
  return asOf;
}

/**
 * Read data/facilities.json and write components/home/hero-plate-paths.ts.
 *
 * Fails loudly (throws) when the source is missing, unreadable, yields no
 * marks, or projects a point outside the viewBox — a silently-empty or
 * silently-clipped plate would render as a plausible-looking map with facts
 * missing from it, with no error anywhere in the build.
 */
export function buildHeroPlate() {
  const facilities = readJson(FACILITIES_PATH, FACILITIES_PATH);
  const meta = readJson(META_PATH, META_PATH);

  const asOf = assertUsableAsOf(meta?.asOf);

  const data = { ...buildPlateData(facilities, WIDTH, HEIGHT), outlines: loadOutlines(WIDTH, HEIGHT) };

  if (!data.outlines.nation || !data.outlines.borders) {
    throw new Error(
      'build-hero-plate: produced empty state outlines — refusing to write a plate whose linework silently vanished'
    );
  }
  if (data.plotted === 0) {
    throw new Error(
      `build-hero-plate: produced 0 marks from ${FACILITIES_PATH} — refusing to write an empty artifact that would blank the hero plate`
    );
  }
  if (data.plotted + data.deduped + data.omitted !== data.total) {
    throw new Error(
      `build-hero-plate: reconciliation failed — plotted ${data.plotted} + deduped ${data.deduped} + omitted ${data.omitted} !== ${data.total} facilities`
    );
  }

  const source = renderModule(data, asOf, WIDTH, HEIGHT);
  // Build BOTH artifacts before writing either, so a throw in the SVG builder
  // cannot leave the TS module updated and the README map stale.
  const svg = buildReadmeSvg(data, asOf, WIDTH, HEIGHT);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, source, 'utf8');
  mkdirSync(dirname(SVG_OUT_PATH), { recursive: true });
  writeFileSync(SVG_OUT_PATH, svg, 'utf8');

  return {
    ...data,
    asOf,
    bytes: Buffer.byteLength(source),
    pathBytes: STATUS_ORDER.reduce(
      (sum, s) => sum + Buffer.byteLength(data.paths[s]),
      0
    ),
    outPath: OUT_PATH,
    outlineBytes: Buffer.byteLength(data.outlines.nation) + Buffer.byteLength(data.outlines.borders),
    svgBytes: Buffer.byteLength(svg),
    svgPath: SVG_OUT_PATH,
  };
}

// Runnable directly: node scripts/build-hero-plate.mjs
// Symlink/space-safe entrypoint check — see scripts/is-entrypoint.ts (plain node cannot import .ts).
function isEntrypoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  try {
    const r = buildHeroPlate();
    console.log(
      `hero-plate: ${r.plotted} marks (${r.deduped} co-located collapsed, ${r.omitted} omitted${
        r.omittedJurisdictions.length ? ` in ${r.omittedJurisdictions.join('/')}` : ''
      }) from ${r.total} facilities -> ${r.outPath.replace(`${repoRoot}/`, '')} (${(r.bytes / 1024).toFixed(1)} KB, paths ${(r.pathBytes / 1024).toFixed(1)} KB); ${r.svgPath.replace(`${repoRoot}/`, '')} (${(r.svgBytes / 1024).toFixed(1)} KB)`
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
