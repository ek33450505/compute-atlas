import { cache as reactCache } from "react";
import { unstable_cache } from "next/cache";

import { FACILITIES_TAG } from "@/lib/cache-tags";
import { getAllFacilities } from "@/lib/data";
import { redactedErrorCode } from "@/lib/db-error";
import { latestPublishedEdition } from "@/lib/dataset-editions";
import { facilitySchema, type Facility } from "@/lib/schema";

/** What the sales pages quote about the dataset, all computed from live data. */
export interface DatasetCounts {
  facilities: number;
  dataCenters: number;
  cryptoSites: number;
  powerPlants: number;
  /** Distinct jurisdictions present: states, DC and territories alike (so not a state count). */
  jurisdictions: number;
  /** Sorted two-letter codes of those jurisdictions. */
  stateCodes: string[];
  operators: number;
  sourceLinks: number;
  /**
   * ISO instant the facilities were COUNTED, not the moment a page rendered, so a cached value keeps its
   * age. It is not the database read time: `getAllFacilities` has its own cache, so the facility set
   * itself can be older than this. Pages therefore say "counted on", never "read from the database".
   */
  asOf: string;
}

export interface OfferEdition {
  date: string;
  recordCount: number | null;
  added: number | null;
  updated: number | null;
  removed: number | null;
  /** True for the first edition, whose stored counts are placeholder zeros, not changes. */
  initial: boolean;
  /** File sizes by file name, in bytes. */
  fileBytes: Record<string, number>;
  /** The changelog's plain headlines (at most ten); for the first edition, only its "Initial edition" line. */
  headlines: string[];
}

/**
 * The three records the sales page shows in full, one per facility type. A fixed constant on
 * purpose: nothing from a request (query, header, cookie) may choose which records render.
 */
export const SAMPLE_FACILITY_IDS: readonly string[] = [
  "meta-hyperion-richland-parish-la",
  "riot-platforms-corsicana-tx",
  "homer-city-energy-campus-generation-pa",
];

type CountableFacility = Pick<Facility, "facilityType" | "operator" | "sources"> & {
  location: Pick<Facility["location"], "state">;
};

export function countDataset(
  facilities: readonly CountableFacility[],
  readAt: Date = new Date(),
): DatasetCounts {
  const states = new Set<string>();
  const operators = new Set<string>();
  let dataCenters = 0;
  let cryptoSites = 0;
  let powerPlants = 0;
  let sourceLinks = 0;
  for (const f of facilities) {
    if (f.facilityType === "data_center") dataCenters++;
    else if (f.facilityType === "crypto_mining") cryptoSites++;
    else if (f.facilityType === "power_generation") powerPlants++;
    if (f.location?.state) {
      states.add(f.location.state);
    }
    if (f.operator) operators.add(f.operator);
    sourceLinks += f.sources?.length ?? 0;
  }
  return {
    facilities: facilities.length,
    dataCenters,
    cryptoSites,
    powerPlants,
    jurisdictions: states.size,
    stateCodes: [...states].sort(),
    operators: operators.size,
    sourceLinks,
    asOf: readAt.toISOString(),
  };
}

/** 9084324 -> "9.1 MB" (decimal megabytes, one decimal). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Exactly the headline lib/dataset-changelog.ts gives the first edition. */
const INITIAL_HEADLINE = /^Initial edition: [\d,]+ records$/;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalises a stored edition row; the changelog summary is opaque JSON, so read it defensively. */
export function toOfferEdition(edition: {
  editionDate: string;
  recordCount: number | null;
  files: readonly { name: string; bytes: number }[];
  changelogSummary: unknown;
}): OfferEdition {
  const summary =
    edition.changelogSummary && typeof edition.changelogSummary === "object"
      ? (edition.changelogSummary as Record<string, unknown>)
      : {};
  // The summary stores no flag. buildChangelog gives the first edition the single headline
  // "Initial edition: N records"; later headlines start "Added:", "Removed:", "Updated:" or a
  // facility name, so the prefix is a safe marker (zero counts alone would also match a quiet week).
  const headlines = Array.isArray(summary.headlines) ? summary.headlines : [];
  const initial = headlines.some((h) => typeof h === "string" && INITIAL_HEADLINE.test(h));
  return {
    date: edition.editionDate,
    recordCount: edition.recordCount,
    added: numberOrNull(summary.added),
    updated: numberOrNull(summary.updated),
    removed: numberOrNull(summary.removed),
    initial,
    fileBytes: Object.fromEntries(edition.files.map((f) => [f.name, f.bytes])),
    headlines: headlines.filter((h): h is string => typeof h === "string"),
  };
}

/** The sample records present in `facilities`, in `SAMPLE_FACILITY_IDS` order; ids not found are skipped. */
export function pickSamples(facilities: readonly Facility[]): Facility[] {
  return SAMPLE_FACILITY_IDS.flatMap((id) => {
    const found = facilities.find((f) => f.id === id);
    if (!found) return [];
    // facilities.json is written after facilitiesSchema.parse (unknown keys stripped, defaults filled),
    // while the live read returns the stored doc as is; parse so the sample has the file's shape.
    const parsed = facilitySchema.safeParse(found);
    if (parsed.success) return [parsed.data];
    console.error("dataset offer: a sample record failed schema validation and was skipped");
    return [];
  });
}

const READ_TIMEOUT_MS = 5000;

/** Rejects if `read` has not settled in `ms`, so a hung DB read is never cached. */
export function withTimeout<T>(read: () => Promise<T>, ms: number = READ_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Call read() before arming the timer: a synchronous throw rejects the promise with no timer left running.
    const pending = read();
    const timer = setTimeout(() => reject(new Error("dataset offer: read timed out")), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readEdition(): Promise<OfferEdition | null> {
  const edition = await withTimeout(latestPublishedEdition);
  return edition ? toOfferEdition(edition) : null;
}

async function readCounts(): Promise<DatasetCounts> {
  // Stamp the count, not the render: unstable_cache keeps this value (asOf included) for up to 24h.
  // The facility set may come from getAllFacilities' own cache and so predate this stamp; the pages' wording
  // ("counted on") claims no more than that.
  const facilities = await withTimeout(getAllFacilities);
  return countDataset(facilities, new Date());
}

async function readSamples(): Promise<Facility[]> {
  return pickSamples(await withTimeout(getAllFacilities));
}

// `unstable_cache` needs the Next request context, which vitest lacks (same dodge as lib/data.ts).
// The cached readers throw on failure or timeout (a thrown read is never cached); the exported
// loaders catch, log a SQLSTATE only, and fail soft to null so the page renders without the strip.
// A cached value (or null) can lag a Friday publish by up to 24h, same as the page's own ISR timer.
const cachedEdition: () => Promise<OfferEdition | null> = process.env.VITEST
  ? readEdition
  : unstable_cache(readEdition, ["dataset-offer-edition"], { revalidate: 86400 });

const cachedCounts: () => Promise<DatasetCounts> = process.env.VITEST
  ? readCounts
  : // Tagged like every other facility-set cache, so `db:sync --apply` (which busts "facilities")
    // refreshes the home, /dataset and /access/commercial counts together instead of leaving them
    // stale for up to 24h. The edition and sample caches stay untagged on purpose.
    unstable_cache(readCounts, ["dataset-offer-counts"], { revalidate: 86400, tags: [FACILITIES_TAG] });

const cachedSamples: () => Promise<Facility[]> = process.env.VITEST
  ? readSamples
  : unstable_cache(readSamples, ["dataset-offer-samples"], { revalidate: 86400 });

/** The latest published edition, or null when there is none or the read fails. */
export async function loadOfferEdition(): Promise<OfferEdition | null> {
  try {
    return await cachedEdition();
  } catch (err) {
    console.error(`dataset offer: edition read failed (code: ${redactedErrorCode(err)})`);
    return null;
  }
}

/**
 * Live dataset counts, or null when the facility read fails. React-cached so `generateMetadata` and the page
 * body share one call per request; the `unstable_cache` entry underneath is unchanged.
 */
export const loadOfferCounts = reactCache(async (): Promise<DatasetCounts | null> => {
  try {
    return await cachedCounts();
  } catch (err) {
    console.error(`dataset offer: facility read failed (code: ${redactedErrorCode(err)})`);
    return null;
  }
});

/** The fixed sample records, or null when the facility read fails. Ids not in the dataset are skipped. */
export async function loadOfferSamples(): Promise<Facility[] | null> {
  try {
    return await cachedSamples();
  } catch (err) {
    console.error(`dataset offer: sample read failed (code: ${redactedErrorCode(err)})`);
    return null;
  }
}

export const n = (value: number): string => value.toLocaleString("en-US");
