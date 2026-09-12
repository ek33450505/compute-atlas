/**
 * Pure geo helpers shared by `geo-check.mjs` and `osm-crosscheck.mjs`.
 *
 * No I/O, no network, no process.argv — just the math and string-shaping the
 * two gate scripts both need, factored out so it can be unit tested directly
 * instead of only indirectly through a live network run.
 */

/** Below this, a pin is close enough to its geocoded address to pass. */
export const WARN_KM = 0.5;
/** Above this, a pin is a real miss, not just parcel/rooftop slop. */
export const FAIL_KM = 2;

/** Distance in km between two WGS84 points. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * A street like "600 & 800 Friberg Parkway" names two parcels and matches
 * neither. Try the whole string first, then the first parcel alone — a
 * multi-parcel record is legitimately `representative_multi_site`, and
 * pinning it at one of its own parcels is the honest reading.
 */
export function addressVariants(loc) {
  const tail = [loc.city, loc.state, loc.postalCode].filter(Boolean).join(", ");
  const out = [`${loc.street}, ${tail}`];
  const split = loc.street.match(/^(\d+)\s*(?:&|and|\/)\s*\d+\s+(.*)$/i);
  if (split) out.push(`${split[1]} ${split[2]}, ${tail}`);
  return out;
}

/**
 * Buckets the distance between a record's stated pin and a geocoder's answer.
 *
 * Thresholds carried over unchanged from `geo-check.mjs`'s original inline
 * branching: >2km is a real miss (corrected under --fix), 0.5-2km is a
 * warning band (still corrected, but flagged separately because it's within
 * plausible parcel/rooftop slop), and <=0.5km is a pass. Extracted to its own
 * function so the branching used in the report is the same code this test
 * suite exercises, instead of a duplicated inline copy that could drift from
 * it silently.
 */
export function classifyDistance(km) {
  if (km > FAIL_KM) return "fail";
  if (km > WARN_KM) return "warn";
  return "ok";
}

/**
 * Parses the required `--dir=<path>` flag out of an argv array.
 *
 * Pure, and therefore unit-testable, which matters because this is the gates'
 * fail-closed boundary and it has already been wrong once. The first version
 * only checked that a `--dir=` token was PRESENT, so `--dir=` with an empty
 * value passed the check, resolved to the process's own working directory,
 * found no `*-discovery.json` there and exited 0 — a green run that checked
 * nothing, which is precisely what requiring the flag exists to prevent. An
 * unset `$WAVE_DIR` in a shell script produces exactly that argv.
 *
 * Returns `{ value }` or `{ error }`. The caller decides how to exit, so this
 * stays free of process and I/O concerns.
 */
export function parseDirFlag(argv) {
  const flag = argv.find((a) => a.startsWith("--dir="));
  if (!flag) {
    return { error: "--dir is required — this gate does not guess which wave to scan." };
  }
  const value = flag.slice("--dir=".length).trim();
  if (!value) {
    return { error: "--dir was given an empty value — refusing to fall back to the current directory." };
  }
  return { value };
}

const geoLib = { WARN_KM, FAIL_KM, haversineKm, addressVariants, classifyDistance, parseDirFlag };
export default geoLib;
