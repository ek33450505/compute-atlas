/**
 * build-hero-points.mjs
 *
 * Builds the homepage hero globe's point set as a static, CDN-cacheable
 * artifact instead of serializing it into every homepage RSC payload.
 *
 * The hero globe is purely decorative (aria-hidden) and never mounts below
 * Tailwind's `sm` breakpoint, yet inlining ~1k `{id, lat, lon, status}` points
 * into the server-rendered payload cost every visitor — phones included —
 * ~98 KB brotli on `/`. Emitting the same array to public/data means the
 * markup carries none of it and the globe fetches it after mount, from the
 * CDN, only on the viewports that actually draw it.
 *
 * Coordinates are rounded to COORD_PRECISION decimals: the globe renders at
 * zoom <= 5, where one pixel is roughly 1.2 km, so 3dp (~110 m) is far below
 * a pixel. Pure size win, no visible change.
 *
 * Output (committed):
 *   public/data/hero-points.json   [{ id, lat, lon, status }, ...]
 *
 * Runs as part of `npm run build:mapdata` (including under --skip-nhd, since
 * it does no network I/O) and standalone via `npm run build:heropoints`.
 *
 * Usage: node scripts/build-hero-points.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const FACILITIES_PATH = resolve(repoRoot, 'data/facilities.json');
const OUT_PATH = resolve(repoRoot, 'public/data/hero-points.json');

/** ~110 m — well under one pixel at the globe's zoom <= 5. */
const COORD_PRECISION = 3;

function round(value) {
  const factor = 10 ** COORD_PRECISION;
  return Math.round(value * factor) / factor;
}

/**
 * Read data/facilities.json and write public/data/hero-points.json.
 *
 * Fails loudly (throws) when the source is missing, unreadable, or yields no
 * points — a silently-empty artifact would blank the hero with no error
 * anywhere in the build.
 *
 * @returns {{ count: number, bytes: number, outPath: string }}
 */
export function buildHeroPoints() {
  let raw;
  try {
    raw = readFileSync(FACILITIES_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `build-hero-points: cannot read ${FACILITIES_PATH}: ${err.message}`
    );
  }

  let facilities;
  try {
    facilities = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `build-hero-points: ${FACILITIES_PATH} is not valid JSON: ${err.message}`
    );
  }

  if (!Array.isArray(facilities)) {
    throw new Error(
      `build-hero-points: expected ${FACILITIES_PATH} to be an array, got ${typeof facilities}`
    );
  }

  const points = [];
  for (const facility of facilities) {
    const lat = facility?.location?.lat;
    const lon = facility?.location?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({
      id: facility.id,
      lat: round(lat),
      lon: round(lon),
      status: facility.status,
    });
  }

  if (points.length === 0) {
    throw new Error(
      `build-hero-points: produced 0 points from ${FACILITIES_PATH} — refusing to write an empty artifact that would blank the hero globe`
    );
  }

  const json = JSON.stringify(points);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${json}\n`);

  return {
    count: points.length,
    bytes: Buffer.byteLength(json) + 1,
    outPath: OUT_PATH,
  };
}

// Runnable directly: node scripts/build-hero-points.mjs
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const { count, bytes, outPath } = buildHeroPoints();
    console.log(
      `hero-points: wrote ${count} points (${bytes} bytes) -> ${outPath.replace(`${repoRoot}/`, '')}`
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
