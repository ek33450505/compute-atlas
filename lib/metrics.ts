import type { Facility } from "@/lib/schema";

/**
 * Environmental Impact Index — a derived, non-persisted 0-100 score computed
 * at render/call time from whichever environmental signals a facility
 * actually reports. Never written back to `facilities.json`.
 *
 * `score` is `null` (not `0`) when zero signals are present — a numeric 0
 * would falsely imply "worst possible," when the true meaning is "no data."
 *
 * `dataCompleteness` is the fraction (0-1) of the expected signal set for
 * the facility's type that was actually populated, so the UI can pair the
 * score with an explicit confidence caveat (e.g. "Score: 62 — 2/5 metrics
 * reported").
 */
export interface EnvironmentalImpactResult {
  score: number | null;
  dataCompleteness: number;
}

/**
 * Reference US grid-average carbon intensity (gCO2/kWh), used as the
 * normalization anchor for both the data-center `gridCarbonIntensityGCo2PerKwh`
 * signal and the crypto `carbonIntensityProxy` signal. Sourced from EPA
 * eGRID national average order-of-magnitude (~380-400 gCO2/kWh); a single
 * reasonable reference constant, not a live lookup (per plan scope).
 */
const US_GRID_AVERAGE_GCO2_PER_KWH = 400;

/** Clamp a value into [0, 100]. */
function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Maps PUE onto a 0-100 band where 1.0 (ideal) -> 100 and 2.5 (poor) -> 0,
 * linearly interpolated and clamped outside that range.
 */
function scorePue(pue: number): number {
  const normalized = ((2.5 - pue) / (2.5 - 1.0)) * 100;
  return clamp100(normalized);
}

/**
 * Inverts a carbon-intensity figure (gCO2/kWh) against the US grid-average
 * reference: at or below 0 -> 100 (best), at or above 2x the reference -> 0
 * (worst), linear in between.
 */
function scoreCarbonIntensity(gCo2PerKwh: number): number {
  const normalized = (1 - gCo2PerKwh / (US_GRID_AVERAGE_GCO2_PER_KWH * 2)) * 100;
  return clamp100(normalized);
}

/** Renewable percent (0-100) is already on the target band — used directly. */
function scoreRenewablePercent(renewablePercent: number): number {
  return clamp100(renewablePercent);
}

const DATA_CENTER_EXPECTED_FIELDS = 3; // pue, renewablePercent, gridCarbonIntensityGCo2PerKwh
const CRYPTO_MINING_EXPECTED_FIELDS = 1; // carbonIntensityProxy

/**
 * Computes the Environmental Impact Index for a single facility.
 * Averages only the sub-scores for signals actually present; returns
 * `score: null` when no signals are present at all.
 */
export function getEnvironmentalImpactIndex(
  facility: Facility
): EnvironmentalImpactResult {
  const subScores: number[] = [];
  let populatedFields = 0;
  let expectedFields = 0;

  if (facility.facilityType === "data_center") {
    expectedFields = DATA_CENTER_EXPECTED_FIELDS;
    const env = facility.environmental;

    if (env?.pue !== undefined) {
      subScores.push(scorePue(env.pue));
      populatedFields++;
    }
    if (env?.renewablePercent !== undefined) {
      subScores.push(scoreRenewablePercent(env.renewablePercent));
      populatedFields++;
    }
    if (env?.gridCarbonIntensityGCo2PerKwh !== undefined) {
      subScores.push(scoreCarbonIntensity(env.gridCarbonIntensityGCo2PerKwh));
      populatedFields++;
    }
  } else {
    expectedFields = CRYPTO_MINING_EXPECTED_FIELDS;
    const env = facility.environmental;

    if (env?.carbonIntensityProxy !== undefined) {
      subScores.push(scoreCarbonIntensity(env.carbonIntensityProxy));
      populatedFields++;
    }
  }

  const dataCompleteness =
    expectedFields > 0 ? populatedFields / expectedFields : 0;

  if (subScores.length === 0) {
    return { score: null, dataCompleteness };
  }

  const score =
    subScores.reduce((sum, s) => sum + s, 0) / subScores.length;

  return { score, dataCompleteness };
}
