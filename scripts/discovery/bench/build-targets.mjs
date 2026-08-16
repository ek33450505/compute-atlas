// Build targets.json from the LIVE DB (data/facilities.json), not hand-typed.
// s97: ground truth must come from the record, and the record's shape is
// capacityMw:{planned,operational} + energy:{source,utility,onSiteGenerationMw}.
// Keeps the original 7 (already hand-labeled, carry known traps) and adds a
// bucket-balanced set: both-capacities, operational-only, planned-only,
// on-site generation, and no-capacity abstention cases.
import { readFileSync, writeFileSync } from "node:fs";
const F = JSON.parse(
  readFileSync(new URL("../../../data/facilities.json", import.meta.url).pathname, "utf8")
);
const arr = Array.isArray(F) ? F : F.facilities || [];
const byId = Object.fromEntries(arr.map((f) => [f.id, f]));

const KEEP = ["flexential-hillsboro-5-or","qts-hillsboro-2-or","crane-pdx02-forest-grove-or",
  "tract-altoona-ia","1623-farnam-omaha-ne","aligned-west-jordan-ut","summit-ridge-santaquin-ut"];

const ADD = [
  // both planned AND operational -- the hardest discrimination
  "applied-digital-polaris-forge-1-ellendale-nd","aws-cumulus-salem-township-pa",
  "bitfarms-panther-creek-nesquehoning-pa","big-watt-digital-onida-sd","atlas-power-williston-nd",
  // operational only
  "aligned-iad-01-va","aaim-data-centers-blue-earth-mn","ark-data-centers-akron-i-summit-county-oh",
  "applied-digital-jamestown-nd",
  // planned only ('caprock' is the >=500MW human-review trigger)
  "5c-group-vultr-prime-ohio-springfield-oh","aligned-project-caprock-hale-county-tx",
  "alterra-development-marshall-mi","aligned-neo-01-oh","aligned-phx13-glendale-az",
  // on-site generation
  "google-nebraska-ai-campus-proposed","fleet-data-centers-storey-county-nv",
  "aligned-phx-01-02-03-az","apple-maiden-nc","creekstone-delta-ut",
  // no capacity recorded -- abstention candidates
  "a1-data-center-millville-nj","9ldg-niagara-falls-ny","air-products-cetronia-road-upper-macungie-pa",
  "adp-ladysmith-data-hub-caroline-va","aligned-conesville-oh","32-avenue-of-the-americas-ny",
];

// Hand-labeled cases with NO live DB row. Kept deliberately: the Flexential page is
// the bench's best entity-binding trap (36 MW for Hillsboro 5, vs 360 MW company-wide
// and 108 MW for a Dallas site). The page states "Hillsboro 5 is 358,000 square feet
// with 36 megawatts capacity" -- verified by reading, s97.
// ⚠️ SURFACED, NOT FIXED: Hillsboro 5 is absent from the live dataset even though this
// source names it, while flexential-portland-hillsboro-3-or is recorded at
// operational:36. Worth checking for an s87-shaped right-number/wrong-site binding.
const MANUAL = {
  "flexential-hillsboro-5-or": {
    id: "flexential-hillsboro-5-or", name: "Flexential Hillsboro 5",
    city: "Hillsboro", state: "OR", facilityType: "data_center", status: "operating",
    truth: {
      capacityMwPlanned: null, capacityMwOperational: 36,
      energySource: null, energyUtility: null, onSiteGenerationMw: null,
      // "496,000 sq ft across 20 acres ... including four facilities" -- the 20 acres
      // is a multi-facility aggregate, so acreage for THIS site is not stated.
      landAcres: null, investmentUsd: null,
    },
    sources: ["https://coloradobiz.com/flexential-acquires-two-hillsboro-data-center-properties/"],
  },
};

const okUrl = (u) => u && /^https?:/i.test(u) && !/\.pdf(\?|$)/i.test(u);
const out = [];
for (const id of [...KEEP, ...ADD]) {
  if (MANUAL[id]) { out.push(MANUAL[id]); continue; }
  const f = byId[id];
  if (!f) { console.log("MISSING", id); continue; }
  const sources = (f.sources || []).map((s) => s.url).filter(okUrl);
  if (!sources.length) { console.log("no usable source", id); continue; }
  out.push({
    id: f.id, name: f.name, city: f.location?.city, state: f.location?.state,
    facilityType: f.facilityType, status: f.status,
    truth: {
      capacityMwPlanned: f.capacityMw?.planned ?? null,
      capacityMwOperational: f.capacityMw?.operational ?? null,
      energySource: f.energy?.source ?? null,
      energyUtility: f.energy?.utility ?? null,
      onSiteGenerationMw: f.energy?.onSiteGenerationMw ?? null,
      landAcres: f.landAcres ?? null,
      investmentUsd: f.investmentUsd ?? null,
    },
    sources,
  });
}
writeFileSync(new URL("./targets.json", import.meta.url).pathname, JSON.stringify(out, null, 2));
console.log(`\nwrote ${out.length} targets (${KEEP.length} kept + ${out.length - KEEP.length} added)`);
