import { unstable_cache } from "next/cache";

import { getAllFacilities } from "@/lib/data";
import { redactedErrorCode } from "@/lib/db-error";
import { latestPublishedEdition } from "@/lib/dataset-editions";
import type { Facility } from "@/lib/schema";

/** What the sales pages quote about the dataset, all computed from live data. */
export interface DatasetCounts {
  facilities: number;
  dataCenters: number;
  cryptoSites: number;
  powerPlants: number;
  states: number;
  operators: number;
  sourceLinks: number;
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
}

type CountableFacility = Pick<Facility, "facilityType" | "operator" | "sources"> & {
  location: Pick<Facility["location"], "state">;
};

export function countDataset(facilities: readonly CountableFacility[]): DatasetCounts {
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
    if (f.location?.state) states.add(f.location.state);
    if (f.operator) operators.add(f.operator);
    sourceLinks += f.sources?.length ?? 0;
  }
  return {
    facilities: facilities.length,
    dataCenters,
    cryptoSites,
    powerPlants,
    states: states.size,
    operators: operators.size,
    sourceLinks,
  };
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-11-10" -> "10 November 2026"; anything else comes back unchanged. */
export function formatEditionDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return iso;
  return `${Number(m[3])} ${month} ${m[1]}`;
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
  };
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
  return countDataset(await withTimeout(getAllFacilities));
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
  : unstable_cache(readCounts, ["dataset-offer-counts"], { revalidate: 86400 });

/** The latest published edition, or null when there is none or the read fails. */
export async function loadOfferEdition(): Promise<OfferEdition | null> {
  try {
    return await cachedEdition();
  } catch (err) {
    console.error(`dataset offer: edition read failed (code: ${redactedErrorCode(err)})`);
    return null;
  }
}

/** Live dataset counts, or null when the facility read fails. */
export async function loadOfferCounts(): Promise<DatasetCounts | null> {
  try {
    return await cachedCounts();
  } catch (err) {
    console.error(`dataset offer: facility read failed (code: ${redactedErrorCode(err)})`);
    return null;
  }
}

export const n = (value: number): string => value.toLocaleString("en-US");
