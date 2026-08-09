/**
 * One-shot normalization: strips " County" / " Parish" / " Borough" suffixes
 * from location.county across data/facilities.json, so the field matches the
 * project convention (bare county names) documented in docs/methodology.md
 * and relied on by lib/metros.ts. Never strips " city" (Virginia independent
 * cities are distinct civil divisions from same-named counties).
 *
 * Special case: google-nebraska-ai-campus-proposed has a two-county value
 * ("Otoe / Gage County") crammed into the single-county field. A prior wave
 * rejected expanding this to a list, so it's set to the primary county
 * ("Otoe") with the multi-county nuance already preserved in `notes`.
 *
 * Run once: node scripts/normalize-counties.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dataPath = path.resolve(process.cwd(), "data", "facilities.json");
const raw = readFileSync(dataPath, "utf-8");
const facilities = JSON.parse(raw);

const SUFFIX_RE = /\s+(County|Parish|Borough)$/i;
let changed = 0;

for (const record of facilities) {
  const county = record.location?.county;
  if (typeof county !== "string") continue;

  if (record.id === "google-nebraska-ai-campus-proposed") {
    if (county !== "Otoe") {
      record.location.county = "Otoe";
      changed++;
    }
    continue;
  }

  if (SUFFIX_RE.test(county)) {
    record.location.county = county.replace(SUFFIX_RE, "").trim();
    changed++;
  }
}

writeFileSync(dataPath, JSON.stringify(facilities, null, 2) + "\n", "utf-8");
console.log(`Normalized ${changed} county values across ${facilities.length} records.`);
