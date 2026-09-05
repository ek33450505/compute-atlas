// Build targets.json from the LIVE DB (data/facilities.json), not hand-typed.
// Ground truth must come from the record, and the record's shape is
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
// with 36 megawatts capacity" -- verified by reading.
// ⚠️ SURFACED, NOT FIXED: Hillsboro 5 is absent from the live dataset even though this
// source names it, while flexential-portland-hillsboro-3-or is recorded at
// operational:36. Worth checking for a right-number/wrong-site binding error like ones seen before.
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
      // No live DB row to seed from (see the header note above), and the page
      // wasn't re-read for cooling -- left null for shape consistency with the
      // generated targets rather than implying an answer.
      coolingType: null,
    },
    sources: ["https://coloradobiz.com/flexential-acquires-two-hillsboro-data-center-properties/"],
  },
};

// F3.1: a balanced, operator-diverse corpus for the coolingType field. The 31
// targets above (KEEP+ADD) are already cached and 8-of-9 closed_loop, mostly one
// operator -- a coolingType bench built only from them would be meaningless (no
// way to tell "always guesses closed_loop" from "correctly reads the page").
// Selection rule: max 2 ids per operator, Aligned deliberately excluded (already
// over-represented in KEEP/ADD), ~8 ids per water.coolingType value plus a
// unknown/abstention group, pulled straight from the live DB by value.
const COOLING = [
  // evaporative
  "aws-galaxy-sidney-oh", "coresite-de3-denver-co", "google-bosc-lima-oh",
  "google-cedar-rapids-ia", "ivcm-imperial-county-ca", "lunavi-cheyenne-wy",
  "markley-lowell-ma", "meta-altoona-ia",
  // air
  "cloudhq-manassas-mcc-va", "corscale-gainesville-crossing-va",
  "crane-pdx01-forest-grove-or", "cyrusone-project-peach-palmetto-ga",
  "dc-blox-atlanta-west-ga", "dcblox-atlanta-east-conyers-ga",
  "edgecore-mesa-az", "edged-atlanta-tilford-yard-ga",
  // hybrid
  "avaio-taurus-brandon-ms", "dartpoints-greenville-sc", "equinix-ashburn-va",
  "h5-buffalo-i-lockport-ny", "h5-la-vista-ne", "lambda-chicago-edgeconnex-il",
  "microsoft-el-mirage-az", "microsoft-ginger-west-ia",
  // closed_loop
  "applied-digital-delta-forge-1-la", "beale-project-blue-pima-county-az",
  "cerebras-oklahoma-city-ok", "cleanarc-ruther-glen-va", "cloudburst-san-marcos-tx",
  "cloverleaf-project-open-sky-piedmont-ok", "cologix-johnstown-oh",
  "colovore-reno-1-storey-county-nv",
  // unknown (abstention candidates)
  "beltline-luther-horizon-technology-park-ok", "compass-lauderdale-meridian-ms",
  "cyrusone-nas-lemoore-ca", "fermi-matador-amarillo-tx",
  "galaxy-helios-dickens-county-tx", "global-ai-windsor-co",
];

const okUrl = (u) => u && /^https?:/i.test(u) && !/\.pdf(\?|$)/i.test(u);
const out = [];
for (const id of [...KEEP, ...ADD, ...COOLING]) {
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
      // NOTE water.coolingType, not mining.coolingType -- different field, different
      // vocabulary (mining allows immersion/hydro, which water.coolingType does not).
      // This is a HINT, not ground truth: per the header note, truth must come from
      // reading the page, and copying the DB record verbatim already produced 4 wrong
      // labels in an earlier bench (see the bench README).
      coolingType: f.water?.coolingType ?? null,
    },
    sources,
  });
}
writeFileSync(new URL("./targets.json", import.meta.url).pathname, JSON.stringify(out, null, 2));
console.log(`\nwrote ${out.length} targets (${KEEP.length} kept + ${out.length - KEEP.length} added)`);
