/**
 * Coordinate check — a gate step the wave chain did not have.
 *
 * `validate.ts` proves a record's SHAPE, `dupe-check.mjs` proves it is not a
 * near-duplicate of a live row, and `check-urls.sh` proves its sources were
 * really fetched. Nothing proved that a record's lat/lon is anywhere near the
 * street address the record itself states.
 *
 * That gap is not hypothetical. On 2026-09-12 the MA discovery agent reported,
 * honestly, that no source stated coordinates for any of its seven records and
 * that it had therefore geocoded each one "using my own geographic knowledge"
 * of the corporate parks involved. Checked against the US Census Bureau
 * geocoder, four of the five verifiable pins were 2.8–4.4 km from their own
 * stated address, and the fifth was 1.2 km off. Every one carried
 * `precision: "approximate"`, which is true but does not mean "several km out".
 *
 * Model recall is not a geocoder. This script is.
 *
 * The Census geocoder is authoritative for US street addresses, free, and
 * needs no key. Where it matches, its answer beats the record's, because the
 * ADDRESS came from a fetched source while the PIN came from recall — so when
 * the two disagree, correct the pin toward the address, never the reverse.
 *
 *   node scripts/wave/geo-check.mjs --dir=wave-2026-09-12          # report only (default)
 *   node scripts/wave/geo-check.mjs --dir=wave-2026-09-12 --fix    # rewrite failing pins
 *
 * A record with no `location.street` cannot be checked this way and is
 * reported as UNVERIFIABLE — which is a finding, not a pass.
 *
 * `--dir` is required and resolved relative to the current working
 * directory — this gate does not guess which wave to scan. A gate that
 * silently scans the wrong (or a stale) directory reports a clean run over
 * nothing, which is worse than not running at all.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { haversineKm, addressVariants, classifyDistance, parseDirFlag } from "./geo-lib.mjs";

const USAGE = "Usage: node scripts/wave/geo-check.mjs --dir=<wave-directory> [--fix] [--only=STATE]";
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
const FIX = process.argv.includes("--fix");
/**
 * `--only=MA` restricts the run to matching artifacts. This exists because the
 * wave's agents finish at different times and `--fix` REWRITES files: running
 * unfiltered while a sibling agent is still flushing its own artifact is a
 * lost-update race between two writers. Fix each state as it lands.
 */
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);

/**
 * Pins a human already adjudicated against a HIGHER authority than Census
 * (a source-stated coordinate, or an OSM mapped building). Census will keep
 * disagreeing with these forever, so without this list every future `--fix`
 * quietly reverts them to the weaker source — and the revert is indistinguishable
 * from a routine correction in the log. Reported, never rewritten.
 */
let ADJUDICATED = {};
try {
  ADJUDICATED = JSON.parse(readFileSync(join(WAVE_DIR, "geo-adjudicated.json"), "utf8")).records ?? {};
} catch {
  ADJUDICATED = {};
}

async function geocode(address) {
  const url =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
    `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const match = json?.result?.addressMatches?.[0];
  if (!match) return null;
  return { lat: match.coordinates.y, lon: match.coordinates.x, matched: match.matchedAddress };
}

async function main() {
  const files = readdirSync(WAVE_DIR)
    .filter((f) => f.endsWith("-discovery.json"))
    .filter((f) => !ONLY || f.includes(ONLY))
    .sort();
  /**
   * Exit non-zero rather than returning quietly. A gate that finds nothing to
   * check and reports success is indistinguishable from a gate that checked
   * everything and found it clean — the whole failure mode this flag exists to
   * prevent, just one level further in.
   */
  if (files.length === 0) {
    console.error(
      ONLY
        ? `no *-discovery.json in ${WAVE_DIR} matching --only="${ONLY}" — NOTHING WAS CHECKED.`
        : `no *-discovery.json artifacts in ${WAVE_DIR} — NOTHING WAS CHECKED.`,
    );
    process.exitCode = 1;
    return;
  }
  const corrections = [];
  let adjudicated = 0;
  let fail = 0;
  let warn = 0;
  let ok = 0;
  let unverifiable = 0;

  for (const file of files) {
    let records;
    try {
      records = JSON.parse(readFileSync(join(WAVE_DIR, file), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(records) || records.length === 0) continue;

    console.log(`\n=== ${file}`);
    let dirty = false;

    for (const rec of records) {
      const loc = rec.location ?? {};
      const label = (rec.id ?? "<no id>").padEnd(40);

      if (!loc.street) {
        unverifiable += 1;
        console.log(`  ? ${label} UNVERIFIABLE — no street; pin rests on "${loc.city ?? "?"}, ${loc.state ?? "?"}" alone`);
        continue;
      }

      let hit = null;
      for (const variant of addressVariants(loc)) {
        try {
          hit = await geocode(variant);
        } catch (err) {
          console.log(`  ! ${label} GEOCODER ERROR — ${err.message} (inconclusive, not a finding)`);
          break;
        }
        if (hit) break;
      }
      // Be a polite client of a government API.
      await new Promise((r) => setTimeout(r, 250));

      if (!hit) {
        unverifiable += 1;
        console.log(`  ? ${label} NO MATCH for "${loc.street}" — geocoder cannot confirm or refute this pin`);
        continue;
      }

      const km = haversineKm(loc.lat, loc.lon, hit.lat, hit.lon);

      /**
       * ALWAYS print the record's own coordinate, in every branch, and record
       * every rewrite to an audit file.
       *
       * The first version of this script printed the original only on FAIL, so
       * a WARN-tier correction silently destroyed the agent-supplied value with
       * no way to recover it. That bit immediately: an agent reported its pin
       * came from coordinates PRINTED ON THE OPERATOR'S OWN PAGE — which would
       * outrank any geocoder — and by then the number was gone from both the
       * artifact and the log. A tool that corrects data must leave the prior
       * value readable, or it is not a correction, it is an overwrite.
       */
      const applyFix = () => {
        if (!FIX) return;
        if (ADJUDICATED[rec.id]) return;
        corrections.push({
          file,
          id: rec.id,
          before: { lat: loc.lat, lon: loc.lon, precision: loc.precision },
          after: { lat: Number(hit.lat.toFixed(5)), lon: Number(hit.lon.toFixed(5)) },
          movedKm: Number(km.toFixed(3)),
          authority: "us-census-geocoder",
          matchedAddress: hit.matched,
        });
        loc.lat = Number(hit.lat.toFixed(5));
        loc.lon = Number(hit.lon.toFixed(5));
        if (loc.precision !== "representative_multi_site") loc.precision = "approximate";
        dirty = true;
        console.log(`      → corrected to ${loc.lat},${loc.lon} (precision: ${loc.precision})`);
      };

      const adjudication = ADJUDICATED[rec.id];
      if (adjudication) {
        adjudicated += 1;
        console.log(
          `  ⚖ ${label} ${km.toFixed(2)} km from Census — ADJUDICATED to ${adjudication.authority}; not rewritten`,
        );
        continue;
      }

      const verdict = classifyDistance(km);
      if (verdict === "fail") {
        fail += 1;
        console.log(
          `  ✗ ${label} ${km.toFixed(2)} km OFF — record ${loc.lat},${loc.lon} vs ${hit.lat.toFixed(4)},${hit.lon.toFixed(4)} [${hit.matched}]`,
        );
        applyFix();
      } else if (verdict === "warn") {
        warn += 1;
        console.log(
          `  ~ ${label} ${km.toFixed(2)} km off — record ${loc.lat},${loc.lon} vs ${hit.lat.toFixed(4)},${hit.lon.toFixed(4)} [${hit.matched}]`,
        );
        applyFix();
      } else {
        ok += 1;
        console.log(`  ✓ ${label} ${km.toFixed(2)} km`);
      }
    }

    if (FIX && dirty) {
      writeFileSync(join(WAVE_DIR, file), `${JSON.stringify(records, null, 2)}\n`);
      console.log(`  WROTE corrected ${file}`);
    }
  }

  if (FIX && corrections.length > 0) {
    const ledger = join(WAVE_DIR, "geo-corrections.json");
    let prior = [];
    try {
      prior = JSON.parse(readFileSync(ledger, "utf8"));
    } catch {
      prior = [];
    }
    writeFileSync(ledger, `${JSON.stringify([...prior, ...corrections], null, 2)}\n`);
    console.log(`\nAUDIT: appended ${corrections.length} correction(s) to geo-corrections.json`);
  }

  console.log(
    `\n---\nOK(<=0.5km): ${ok}   WARN(0.5-2km): ${warn}   FAIL(>2km): ${fail}   ` +
      `UNVERIFIABLE: ${unverifiable}   ADJUDICATED(not rewritten): ${adjudicated}`,
  );
  if (!FIX && (fail > 0 || warn > 0)) {
    console.log("Re-run with --fix to move each failing pin onto its own stated address.");
    process.exitCode = 1;
  }
}

await main();
