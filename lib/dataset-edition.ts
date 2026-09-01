import meta from "@/data/facilities.meta.json";

/**
 * Public identity of the dataset release, for anyone citing it (academic
 * inquiries, the `.zenodo.json` record, a future citation UI). Sourced from
 * `data/facilities.meta.json`, which `scripts/export.ts` regenerates on every
 * publish — see `sourceRelease` there.
 */
export interface DatasetEdition {
  /** Semver-ish release string, e.g. "1.30.0". Sourced from `meta.sourceRelease`. */
  version: string;
  /** ISO-8601 timestamp of the export that produced the current dataset. */
  asOf: string;
  /** Total facility count as of `asOf`. */
  recordCount: number;
  /** Schema version the records conform to. */
  schemaVersion: number;
}

/**
 * Fallback returned when `facilities.meta.json` is missing a field or has an
 * unexpected shape. A citation block rendering "unknown" is preferable to a
 * page (or this public API route) 500ing over metadata that isn't the actual
 * dataset content.
 */
const FALLBACK_EDITION: DatasetEdition = {
  version: "unknown",
  asOf: "unknown",
  recordCount: 0,
  schemaVersion: 0,
};

/**
 * Returns the current dataset edition, read from the statically-imported
 * `data/facilities.meta.json`. Imported (not read from disk at request time)
 * so this works unmodified on Vercel's serverless runtime, matching the
 * existing `@/data/*.json` import convention used by `lib/siting-context.ts`.
 */
export function getDatasetEdition(): DatasetEdition {
  const raw = meta as Partial<{
    sourceRelease: string;
    asOf: string;
    recordCount: number;
    schemaVersion: number;
  }>;

  const version = typeof raw.sourceRelease === "string" ? raw.sourceRelease : undefined;
  const asOf = typeof raw.asOf === "string" ? raw.asOf : undefined;
  const recordCount = typeof raw.recordCount === "number" ? raw.recordCount : undefined;
  const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : undefined;

  if (
    version === undefined ||
    asOf === undefined ||
    recordCount === undefined ||
    schemaVersion === undefined
  ) {
    return FALLBACK_EDITION;
  }

  return { version, asOf, recordCount, schemaVersion };
}
