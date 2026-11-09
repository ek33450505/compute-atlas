import type { DatasetChangelogSummary } from "@/lib/dataset-changelog";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

/**
 * Pure builder for an edition's `README.txt`. The attribution and citation
 * wording matches the "How to cite" page (`app/data/page.tsx`). No checksums
 * on purpose: served files are watermarked per recipient, so their bytes
 * differ between recipients and a published hash would match none of them.
 */

export interface BuildReadmeInput {
  /** YYYY-MM-DD, a real calendar date. */
  editionDate: string;
  editionId: string;
  recordCount: number;
  /**
   * True for the first edition (the `DatasetChangelog`'s `initial` flag). Passed
   * explicitly, never inferred from zero counts: a later edition with no changes
   * also has zero counts. Required.
   */
  initial: boolean;
  summary?: DatasetChangelogSummary;
}

const WRAP_COLUMNS = 80;

/**
 * The attribution line from the cite page. It is kept on ONE line (it runs
 * past 80 columns) so a recipient can copy it verbatim.
 */
const ATTRIBUTION_LINE = `Data from Compute Atlas by Edward Kubiak (${siteConfig.url}), licensed under CC BY 4.0 (${DATASET_LICENSE_URL}).`;

const FILES: ReadonlyArray<readonly [string, string]> = [
  ["facilities.json", "The facility records, one object per facility."],
  ["facilities.csv", "The same records as a flat table (see CSV notes below)."],
  ["siting-context.json", "Regional siting context (nearest water and transmission, basin water stress, aquifer) keyed by facility id."],
  ["changelog.json", "Records added, updated or removed since the previous edition."],
  ["README.txt", "This file."],
];

const CSV_NOTES: readonly string[] = [
  "UTF-8 without a BOM, comma-separated, RFC 4180 quoting, CRLF line endings.",
  "Text cells beginning with =, +, -, @, a tab or a carriage return are prefixed with ' so a spreadsheet does not read it as a formula. Numeric cells are left unprefixed.",
  "Multi-valued fields are joined with ;",
];

/** Greedy word wrap; a word longer than the width stays on its own line. */
function wrap(text: string, width: number, first = "", rest = first): string[] {
  const lines: string[] = [];
  let line = first;
  let fresh = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!fresh && line.length + 1 + word.length > width) {
      lines.push(line);
      line = rest + word;
    } else {
      line += (fresh ? "" : " ") + word;
    }
    fresh = false;
  }
  lines.push(line);
  return lines;
}

function assertEditionDate(value: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`buildReadme: editionDate must be a YYYY-MM-DD calendar date, got ${JSON.stringify(value)}`);
  }
}

export function buildReadme(input: BuildReadmeInput): string {
  const { editionDate, editionId, recordCount, summary, initial } = input;
  assertEditionDate(editionDate);
  if (!/^[A-Za-z0-9._-]+$/.test(editionId)) {
    throw new Error(`buildReadme: editionId must match [A-Za-z0-9._-]+, got ${JSON.stringify(editionId)}`);
  }
  if (!Number.isInteger(recordCount) || recordCount < 0) {
    throw new Error(`buildReadme: recordCount must be a non-negative integer, got ${recordCount}`);
  }

  const out: string[] = [];
  const section = (title: string) => out.push("", title, "-".repeat(title.length));

  out.push(`${siteConfig.name} dataset, edition ${editionDate}`, "=".repeat(44));
  out.push(
    ...wrap(
      `This edition holds ${recordCount.toLocaleString("en-US")} records of U.S. data centers, AI-specific facilities, crypto-mining sites and the power plants built to feed them. Every record is source-cited: it lists the public sources behind it.`,
      WRAP_COLUMNS,
    ),
  );

  section("License and attribution");
  out.push(
    ...wrap(
      `The data is licensed under CC BY 4.0 (${DATASET_LICENSE_URL}), with attribution required. To credit it:`,
      WRAP_COLUMNS,
    ),
    "",
    ATTRIBUTION_LINE,
    "",
    ...wrap(
      `Link ${siteConfig.url}. Say if you changed anything, for example by filtering or joining the records. ${siteConfig.name} is non-partisan and takes no position on any facility, so keep your own analysis or commentary distinct from its records.`,
      WRAP_COLUMNS,
    ),
  );

  section("Citation");
  out.push(
    ...wrap(
      `"${siteConfig.name} dataset, edition ${editionDate}", ${siteConfig.name}, ${siteConfig.url}, accessed [date]. Licensed under CC BY 4.0.`,
      WRAP_COLUMNS,
    ),
    ...wrap("Each record lists its own public sources. Cite those directly when a claim depends on them.", WRAP_COLUMNS),
  );

  section("Files");
  for (const [name, description] of FILES) {
    out.push(...wrap(description, WRAP_COLUMNS, `  ${name.padEnd(21)}`, " ".repeat(23)));
  }
  out.push("", "Files may carry recipient-specific identifiers.");

  section("CSV notes");
  for (const note of CSV_NOTES) out.push(...wrap(note, WRAP_COLUMNS, "- ", "  "));

  if (initial) {
    out.push("", `Initial edition: ${recordCount.toLocaleString("en-US")} records.`);
  } else if (summary) {
    section("Changes since the previous edition");
    out.push(`${summary.added} added, ${summary.updated} updated, ${summary.removed} removed.`);
    for (const headline of summary.headlines) out.push(...wrap(headline, WRAP_COLUMNS, "- ", "  "));
    out.push("Details are in changelog.json.");
  }

  out.push("", `Edition: ${editionDate} (${editionId})`);
  return `${out.join("\n")}\n`;
}
