/**
 * Generates the static dataset downloads served from /data:
 *   public/data/facilities.csv   (lib/export.ts facilitiesToCsv)
 *   public/data/facilities.json  (lib/export.ts facilitiesToJson)
 * from the committed snapshot data/facilities.json.
 *
 * Run via `prebuild` (fail-closed), `predev` (--warn-on-mismatch) and
 * `npm run build:exports` by hand. Reads one file, writes two; no DB, no network.
 * Outputs are gitignored.
 *
 * Deliberate trade-off: these files come from the BUNDLED snapshot, not live
 * Neon. A data-only merge skips the Vercel build (scripts/vercel-ignore-build.sh),
 * so the downloads can lag Neon until the next code deploy. They are produced
 * from the same data/facilities.json that data/facilities.meta.json describes.
 * The only consistency check is that meta's `recordCount` equals the number of
 * records here; nothing compares content or the as-of date. The CSV
 * goes through the same exporter the client-side buttons used, so its format
 * is identical.
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitiesToCsv, facilitiesToJson } from "../lib/export";
import type { Facility } from "../lib/schema";
import { isEntrypoint } from "./is-entrypoint";

export interface DataExportResult {
  csvPath: string;
  jsonPath: string;
  csvBytes: number;
  jsonBytes: number;
  count: number;
  /** Set only in warn mode, when the meta recordCount disagreed with the records. */
  warning?: string;
}

/**
 * Reads `facilitiesPath`, writes facilities.csv and facilities.json into `outDir`.
 * When `metaPath` is given, throws unless its `recordCount` equals the number of
 * records: /data states that count and an "as of" date from the meta file, so a
 * mismatched snapshot would make the page's claim untrue. `warnOnMismatch`
 * (dev only, via --warn-on-mismatch) downgrades that to a warning on the result
 * and still writes the files, so a stale local meta doesn't block `npm run dev`.
 */
export function buildDataExports(
  facilitiesPath: string,
  outDir: string,
  metaPath?: string,
  warnOnMismatch = false,
): DataExportResult {
  const parsed: unknown = JSON.parse(readFileSync(facilitiesPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${facilitiesPath} is not a non-empty array; refusing to publish empty downloads`,
    );
  }
  const facilities: Facility[] = parsed;
  let warning: string | undefined;
  if (metaPath !== undefined) {
    const meta: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    const recordCount =
      typeof meta === "object" && meta !== null && "recordCount" in meta
        ? meta.recordCount
        : undefined;
    if (recordCount !== facilities.length) {
      const detail =
        `${metaPath} recordCount (${String(recordCount)}) != ` +
        `${facilities.length} records in ${facilitiesPath}`;
      if (!warnOnMismatch) {
        throw new Error(
          `${detail}; refusing to publish downloads that contradict the page's stated count`,
        );
      }
      warning = detail;
    }
  }
  const csv = facilitiesToCsv(facilities);
  const json = facilitiesToJson(facilities);

  mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, "facilities.csv");
  const jsonPath = path.join(outDir, "facilities.json");
  writeFileSync(csvPath, csv);
  writeFileSync(jsonPath, json);
  return {
    csvPath,
    jsonPath,
    csvBytes: Buffer.byteLength(csv),
    jsonBytes: Buffer.byteLength(json),
    count: facilities.length,
    ...(warning === undefined ? {} : { warning }),
  };
}

if (isEntrypoint(import.meta.url)) {
  const root = process.cwd();
  const result = buildDataExports(
    path.join(root, "data", "facilities.json"),
    path.join(root, "public", "data"),
    path.join(root, "data", "facilities.meta.json"),
    process.argv.includes("--warn-on-mismatch"),
  );
  if (result.warning !== undefined) console.warn(`data exports WARNING: ${result.warning}`);
  console.log(
    `data exports: ${result.count} facilities -> ` +
      `${path.relative(root, result.csvPath)} (${result.csvBytes} B), ` +
      `${path.relative(root, result.jsonPath)} (${result.jsonBytes} B)`,
  );
}
