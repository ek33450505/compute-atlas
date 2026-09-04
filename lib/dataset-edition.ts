import meta from "@/data/facilities.meta.json";

/**
 * Public identity of the dataset release, for anyone citing it (academic
 * inquiries, the `.zenodo.json` record, a future citation UI). Sourced from
 * `data/facilities.meta.json`, which `scripts/export.ts` regenerates on every
 * publish — see `sourceRelease` there.
 *
 * This describes the last PUBLISHED SNAPSHOT, not the live dataset. Neon is
 * the actual source of truth (facilities can be added or corrected between
 * publishes via `db:sync`), and this type is a frozen picture of one export,
 * not a live read. It does not track live row counts — in particular
 * `recordCount` will legitimately disagree with a live count (e.g.
 * `GET /api/stats`'s `count`, which queries Neon on every request) any time
 * the live dataset has moved since the export that produced `asOf`. Do not
 * read `recordCount` as "how many facilities exist right now" — see
 * `getLiveDatasetEdition` for the shape meant to sit alongside a live count.
 */
export interface DatasetEdition {
  /** Semver-ish release string, e.g. "1.30.0". Sourced from `meta.sourceRelease`. */
  version: string;
  /** ISO-8601 timestamp of the export that produced this snapshot — not "now". */
  asOf: string;
  /** Facility count IN THE SNAPSHOT as of `asOf`. Not a live row count — see the interface doc above. */
  recordCount: number;
  /** Schema version the snapshot's records conform to. */
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

/**
 * `DatasetEdition` minus `recordCount`, for embedding alongside a count that
 * is itself live (read fresh from Neon on the same request) — currently only
 * `GET /api/stats`, which already reports a live `count` at the top level of
 * its payload. Stacking the snapshot's `recordCount` next to that live count
 * in one response invites exactly the misreading this type exists to
 * prevent: two different record totals in one payload with nothing marking
 * them as describing different things. `version`, `asOf`, and `schemaVersion`
 * don't have that live counterpart to collide with, so they're kept.
 */
export type LiveDatasetEdition = Omit<DatasetEdition, "recordCount">;

/**
 * Returns the current dataset edition with `recordCount` stripped — see
 * `LiveDatasetEdition`. Use this (not `getDatasetEdition`) when the response
 * already carries a live record count elsewhere in its own payload.
 */
export function getLiveDatasetEdition(): LiveDatasetEdition {
  const { version, asOf, schemaVersion } = getDatasetEdition();
  return { version, asOf, schemaVersion };
}
