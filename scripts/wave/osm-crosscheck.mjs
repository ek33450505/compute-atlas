/**
 * Second-opinion coordinate check — REPORT ONLY, never writes.
 *
 * `geo-check.mjs` uses the US Census address geocoder, which is authoritative
 * where it matches but silent where it does not: it cannot resolve an
 * unnumbered street ("Centennial Drive"), a private industrial road, or a
 * record that carries no street at all. Those land as UNVERIFIABLE, and an
 * UNVERIFIABLE pin is not a passing pin — it is an unexamined one. In the
 * 2026-09-12 wave that was 7 of 39 records.
 *
 * This fills that gap with OpenStreetMap, and deliberately does NOT auto-fix,
 * because the two sources are not equally trustworthy for this purpose:
 * Nominatim will happily answer a street query with a town centroid where
 * Census fails closed instead. (Census is not itself parcel-accurate — it
 * interpolates, and has been measured 1.9 km off a real address — but it does
 * not substitute a centroid for a miss the way Nominatim can.) Auto-correcting
 * toward a Nominatim centroid would manufacture false precision — the exact
 * failure this whole check exists to catch. So it reports, and a human decides.
 *
 * Two different questions, reported differently, because they are NOT the same
 * strength of evidence:
 *
 *   VERIFY      (record has a street)  — does OSM put that street where the
 *               record's pin is? A small delta is real corroboration.
 *   PLAUSIBLE   (record has no street) — is the pin even near the city it
 *               claims? This can only ever REFUTE, never confirm: a pin sitting
 *               on its city centroid scores 0.00 km and still tells you nothing
 *               about where the facility is.
 *
 *   node scripts/wave/osm-crosscheck.mjs --dir=wave-2026-09-12 [--only=ID]
 *
 * `--dir` is required and resolved relative to the current working
 * directory — this gate does not guess which wave to scan.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { haversineKm, parseDirFlag } from "./geo-lib.mjs";

const USAGE = "Usage: node scripts/wave/osm-crosscheck.mjs --dir=<wave-directory> [--only=STATE]";
const dirFlag = parseDirFlag(process.argv);
if (dirFlag.error) {
  console.error(USAGE);
  console.error(`  ${dirFlag.error}`);
  process.exit(1);
}
/**
 * `resolve`, not `join(process.cwd(), …)`: path.join does not treat a leading
 * "/" as absolute, so `--dir=/tmp/wave` silently became "<repo>/tmp/wave".
 */
const WAVE_DIR = resolve(process.cwd(), dirFlag.value);
/**
 * One stat covers both bad-path cases, and the second one is easy to miss:
 * `existsSync` returns true for a regular FILE, so `--dir=package.json` used
 * to sail past the guard and die inside `readdirSync` as a raw ENOTDIR stack
 * trace. Fail-closed, but unreadable — which is the thing this guard exists
 * to avoid, not merely a cosmetic complaint about it.
 */
const stat = statSync(WAVE_DIR, { throwIfNoEntry: false });
if (!stat) {
  console.error(USAGE);
  console.error(`  no such directory: ${WAVE_DIR}`);
  process.exit(1);
}
if (!stat.isDirectory()) {
  console.error(USAGE);
  console.error(`  not a directory: ${WAVE_DIR}`);
  process.exit(1);
}
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const UA = "compute-atlas-wave-check/1.0 (dataset coordinate verification)";

async function nominatim(query) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" +
    encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.length) return null;
  const hit = json[0];
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    kind: `${hit.category}/${hit.type}`,
    name: hit.display_name,
  };
}

const files = readdirSync(WAVE_DIR)
  .filter((f) => f.endsWith("-discovery.json"))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort();

/**
 * Exit non-zero rather than printing a summary of all zeros. A gate that
 * finds nothing to check and reports success is indistinguishable from a
 * gate that checked everything and found it clean — the whole failure mode
 * this flag exists to prevent, just one level further in.
 */
if (files.length === 0) {
  console.error(
    ONLY
      ? `no *-discovery.json in ${WAVE_DIR} matching --only="${ONLY}" — NOTHING WAS CHECKED.`
      : `no *-discovery.json artifacts in ${WAVE_DIR} — NOTHING WAS CHECKED.`,
  );
  process.exit(1);
}

let refuted = 0;
let corroborated = 0;
let inconclusive = 0;

for (const file of files) {
  let records;
  try {
    records = JSON.parse(readFileSync(join(WAVE_DIR, file), "utf8"));
  } catch {
    continue;
  }
  if (!Array.isArray(records) || records.length === 0) continue;
  console.log(`\n=== ${file}`);

  for (const rec of records) {
    const loc = rec.location ?? {};
    const label = (rec.id ?? "<no id>").padEnd(44);
    const mode = loc.street ? "VERIFY" : "PLAUSIBLE";
    const query = loc.street
      ? `${loc.street}, ${loc.city ?? ""}, ${loc.state}`
      : `${loc.city ?? ""}, ${loc.state}`;

    if (!loc.city && !loc.street) {
      inconclusive += 1;
      console.log(`  · ${label} no city and no street — nothing to cross-check against`);
      continue;
    }

    let hit;
    try {
      hit = await nominatim(query);
    } catch (err) {
      inconclusive += 1;
      console.log(`  ! ${label} OSM error (${err.message}) — inconclusive`);
      continue;
    }
    // Nominatim's usage policy is 1 request/second. Respect it.
    await new Promise((r) => setTimeout(r, 1100));

    if (!hit) {
      inconclusive += 1;
      console.log(`  · ${label} OSM has no feature for "${query}"`);
      continue;
    }

    const km = haversineKm(loc.lat, loc.lon, hit.lat, hit.lon);

    if (mode === "VERIFY") {
      if (km <= 1) {
        corroborated += 1;
        console.log(`  ✓ ${label} ${km.toFixed(2)} km from OSM ${hit.kind} — corroborated`);
      } else {
        refuted += 1;
        console.log(
          `  ✗ ${label} ${km.toFixed(2)} km from OSM ${hit.kind} [${hit.name.slice(0, 70)}] — CHECK BY HAND`,
        );
      }
    } else if (km > 15) {
      refuted += 1;
      console.log(`  ✗ ${label} ${km.toFixed(1)} km from the centre of ${loc.city} — pin is not in its own city`);
    } else {
      inconclusive += 1;
      console.log(`  ~ ${label} ${km.toFixed(1)} km from ${loc.city} centre — inside the city, location within it UNKNOWN`);
    }
  }
}

console.log(
  `\n---\ncorroborated: ${corroborated}   needs-a-human: ${refuted}   inconclusive: ${inconclusive}` +
    `\nNothing was written. "inconclusive" is not a pass.`,
);
