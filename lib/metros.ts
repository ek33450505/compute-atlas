/**
 * Curated metro-area definitions for the by-metro data lens.
 *
 * A "metro" is a hand-picked cluster of counties known for AI data center /
 * crypto-mining / power-generation activity. Matching a facility to a metro
 * is done by (state, county) pair — county alone is not unique across states
 * (e.g. "Washington" county exists in OR, UT, and elsewhere).
 *
 * IMPORTANT — the county-string bug: the live `location.county` field mixes
 * `"X County"` and bare `"X"` for the same county (e.g. both "Loudoun" and
 * "Loudoun County" occur in the data). All counties below are stored
 * normalized (no " County"/" Parish"/" Borough" suffix); use
 * `normalizeCounty` / `metroCountyKey` on both sides of any match so lookups
 * are canonical regardless of which form a given record uses. Do NOT strip
 * a " city" suffix — independent cities are distinct from same-named
 * counties (e.g. Virginia's independent cities).
 */

export interface Metro {
  slug: string;
  name: string; // display name
  states: string[]; // 2-letter codes this metro spans
  counties: [string, string][]; // [stateCode, bareCountyName] — normalized (no " County" suffix)
}

export const METROS: Metro[] = [
  { slug: "northern-virginia", name: "Northern Virginia", states: ["VA"], counties: [["VA","Loudoun"],["VA","Prince William"],["VA","Fauquier"],["VA","Fairfax"]] },
  { slug: "bay-area", name: "Bay Area & Silicon Valley", states: ["CA"], counties: [["CA","Santa Clara"],["CA","San Francisco"],["CA","Alameda"]] },
  { slug: "phoenix", name: "Phoenix", states: ["AZ"], counties: [["AZ","Maricopa"],["AZ","Pinal"]] },
  { slug: "columbus-ohio", name: "Columbus, Ohio", states: ["OH"], counties: [["OH","Licking"],["OH","Franklin"],["OH","Union"],["OH","Delaware"],["OH","Pickaway"],["OH","Fairfield"]] },
  { slug: "chicago", name: "Chicago", states: ["IL"], counties: [["IL","Cook"],["IL","DuPage"],["IL","Grundy"],["IL","Kane"],["IL","Will"],["IL","Kendall"],["IL","Lake"]] },
  { slug: "dallas-fort-worth", name: "Dallas–Fort Worth", states: ["TX"], counties: [["TX","Dallas"],["TX","Collin"],["TX","Ellis"],["TX","Tarrant"],["TX","Hunt"]] },
  { slug: "atlanta", name: "Atlanta", states: ["GA"], counties: [["GA","Fulton"],["GA","Douglas"],["GA","Cobb"],["GA","Bartow"],["GA","Fayette"],["GA","Rockdale"],["GA","Gwinnett"],["GA","Coweta"],["GA","Newton"]] },
  { slug: "fredericksburg-i95", name: "Fredericksburg & the I-95 Corridor", states: ["VA"], counties: [["VA","Spotsylvania"],["VA","Caroline"],["VA","Stafford"],["VA","King George"]] },
  { slug: "portland", name: "Portland & Hillsboro", states: ["OR"], counties: [["OR","Washington"]] },
  { slug: "richmond", name: "Richmond, Virginia", states: ["VA"], counties: [["VA","Chesterfield"],["VA","Henrico"],["VA","Hanover"],["VA","Goochland"]] },
  { slug: "new-york-city", name: "New York City Metro", states: ["NY","NJ"], counties: [["NJ","Hudson"],["NY","New York"],["NJ","Middlesex"],["NY","Rockland"],["NY","Westchester"]] },
  { slug: "kansas-city", name: "Kansas City", states: ["MO","KS"], counties: [["KS","Johnson"],["MO","Clay"],["MO","Jackson"],["KS","Wyandotte"],["MO","Platte"]] },
  { slug: "permian-basin", name: "Permian Basin, West Texas", states: ["TX"], counties: [["TX","Pecos"],["TX","Ector"],["TX","Reeves"],["TX","Winkler"],["TX","Andrews"],["TX","Upton"]] },
  { slug: "austin", name: "Austin", states: ["TX"], counties: [["TX","Travis"],["TX","Caldwell"],["TX","Hays"],["TX","Bastrop"],["TX","Williamson"]] },
  { slug: "las-vegas", name: "Las Vegas", states: ["NV"], counties: [["NV","Clark"]] },
  { slug: "buffalo-niagara", name: "Buffalo–Niagara Falls", states: ["NY"], counties: [["NY","Niagara"],["NY","Erie"]] },
  { slug: "charlotte", name: "Charlotte", states: ["NC"], counties: [["NC","Mecklenburg"],["NC","Iredell"],["NC","Cleveland"]] },
  { slug: "salt-lake-city", name: "Salt Lake City & Utah", states: ["UT"], counties: [["UT","Salt Lake"],["UT","Utah"],["UT","Tooele"]] },
  { slug: "reno", name: "Reno", states: ["NV"], counties: [["NV","Storey"],["NV","Washoe"]] },
  { slug: "scranton-wilkes-barre", name: "Scranton–Wilkes-Barre", states: ["PA"], counties: [["PA","Luzerne"],["PA","Lackawanna"]] },
  { slug: "central-washington", name: "Central Washington", states: ["WA"], counties: [["WA","Grant"],["WA","Douglas"],["WA","Chelan"]] },
  { slug: "nashville", name: "Nashville", states: ["TN"], counties: [["TN","Williamson"],["TN","Montgomery"],["TN","Sumner"]] },
  { slug: "denver", name: "Denver", states: ["CO"], counties: [["CO","Arapahoe"],["CO","Denver"]] },
  { slug: "san-antonio", name: "San Antonio", states: ["TX"], counties: [["TX","Bexar"],["TX","Medina"]] },
  { slug: "seattle", name: "Seattle", states: ["WA"], counties: [["WA","King"]] },
  { slug: "sacramento", name: "Sacramento", states: ["CA"], counties: [["CA","Sacramento"]] },
  { slug: "cheyenne", name: "Cheyenne", states: ["WY"], counties: [["WY","Laramie"]] },
];

/**
 * Strips a trailing " County" / " Parish" / " Borough" suffix (case-insensitive).
 * Does NOT strip " city" — independent cities are distinct from same-named counties.
 */
export function normalizeCounty(raw: string): string {
  return raw.replace(/\s+(County|Parish|Borough)$/i, "").trim();
}

/** Canonical join key for a (state, county) pair — normalize both sides before matching. */
export function metroCountyKey(state: string, county: string): string {
  return `${state.toUpperCase()}|${normalizeCounty(county).toLowerCase()}`;
}

export function getMetroBySlug(slug: string): Metro | undefined {
  return METROS.find((m) => m.slug === slug);
}
