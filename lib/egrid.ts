/**
 * EPA eGRID2023 (Data Rev. 2, released 2025-06-12) subregion CO2 output
 * emission rates — Table 1 "Subregion Output Emission Rates," column
 * "Total output emission rates — CO2 (lb/MWh)".
 * Source: https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx
 * Figures below were read directly from that file's raw data, not a
 * third-party aggregator. Public domain (US government dataset). eGRID has
 * no live API — EPA publishes it as a static annual download (~1yr lag), so
 * this table needs a manual refresh each January when a new release ships.
 */
export const SUBREGION_CO2_LB_PER_MWH: Record<string, number> = {
  ERCT: 733.86, // ERCOT (most of Texas)
  CAMX: 428.46, // WECC California
  AZNM: 703.70, // WECC Southwest (Arizona/New Mexico)
  NWPP: 631.74, // WECC Northwest
  RFCW: 911.42, // RFC West (Ohio Valley)
  RFCE: 596.90, // RFC East
  SRVC: 593.42, // SERC Virginia/Carolina
  SRSO: 842.33, // SERC South (Georgia and neighbors)
  MROW: 920.13, // MRO West (Iowa/Nebraska)
};

const LB_PER_MWH_TO_G_PER_KWH = 0.453592;

/**
 * States whose eGRID subregion assignment is confidently single-subregion
 * (per EPA's eGRID2023 Technical Guide) AND where we have a primary-verified
 * CO2 figure above. States that split across multiple subregions (e.g. the
 * TX panhandle, NY's 3-way NYUP/NYCW/NYLI split, OH's RFCW/RFCE split, MI's
 * RFCW/MROE split, far-eastern CA counties) are deliberately omitted rather
 * than defaulted to a guess — a wrong subregion assignment would misrepresent
 * a facility's actual grid mix worse than an honest "unknown" would.
 * Expand this table using EPA's per-plant eGRID crosswalk file (not
 * guesswork) as more subregions get verified.
 */
const STATE_TO_SUBREGION: Record<string, string> = {
  TX: "ERCT",
  AZ: "AZNM",
  NM: "AZNM",
  GA: "SRSO",
  VA: "SRVC",
  OR: "NWPP",
  CA: "CAMX",
  IA: "MROW",
  NE: "MROW",
};

/**
 * Looks up the eGRID-derived grid carbon intensity (gCO2/kWh) for a US state.
 * Returns `null` when the state isn't in the confident-assignment table
 * above — callers MUST treat that as "unknown," never substitute a guess or
 * the national average in its place.
 */
export function getGridCarbonIntensityGCo2PerKwh(state: string): number | null {
  const subregion = STATE_TO_SUBREGION[state];
  if (!subregion) return null;
  const lbPerMwh = SUBREGION_CO2_LB_PER_MWH[subregion];
  if (lbPerMwh === undefined) return null;
  return lbPerMwh * LB_PER_MWH_TO_G_PER_KWH;
}
