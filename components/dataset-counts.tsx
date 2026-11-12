import {
  n,
  type DatasetCounts as DatasetCountsData,
  type OfferEdition,
} from "@/lib/dataset-offer";
import { formatEditionDate } from "@/lib/edition-date";

/** "3,174 sites, counted on 12 November 2026". The date is when the count was taken, never the render time. */
export function datasetCountPhrase(
  counts: Pick<DatasetCountsData, "facilities" | "asOf">,
  noun: string = "sites",
): string {
  return `${n(counts.facilities)} ${noun}, counted on ${formatEditionDate(counts.asOf)}`;
}

interface DatasetCountsProps {
  /** Live counts; null when the read failed, in which case no live number is printed. */
  counts: DatasetCountsData | null;
  /** The latest published edition; null when there is none or its read failed. */
  edition?: OfferEdition | null;
  /** Counted noun for the live figure. */
  noun?: string;
  className?: string;
}

/**
 * The one place a page states how many facilities the dataset holds. It always dates the figure,
 * and when an edition exists it says which number belongs to the edition and which to the live site,
 * so two honest counts never read as a contradiction. Every number comes from the loaders; nothing is typed in.
 */
export function DatasetCounts({ counts, edition, noun = "sites", className }: DatasetCountsProps) {
  const live = counts ? datasetCountPhrase(counts, noun) : null;
  const editionCount = edition && edition.recordCount !== null ? edition : null;

  // One template literal per sentence, so SSR emits one text node (no `<!-- -->` splits).
  // A read that failed (null) contributes nothing: the other number, if any, still stands alone.
  const editionSentence = editionCount
    ? `Latest edition (${formatEditionDate(editionCount.date)}): ${n(editionCount.recordCount as number)} records.`
    : null;
  let text: string | null = null;
  if (editionSentence && live) text = `${editionSentence} The live site has ${live}.`;
  else if (editionSentence) text = editionSentence;
  else if (live) text = `${live[0].toUpperCase()}${live.slice(1)}.`;
  if (!text) return null;
  return <p className={className}>{text}</p>;
}

/**
 * The edition's changes, as one line shared by /dataset and /access/commercial. <DatasetCounts> already
 * states "Latest edition (date): N records.", so with a record count this adds only
 * "Since the previous edition: 7 added, 8 updated, 0 removed." (nothing for a first edition, which has no
 * changes). Without a record count that sentence is absent, so this line carries the edition date itself.
 */
export function editionChangesLine(edition: OfferEdition | null): string | null {
  if (!edition) return null;
  const clauses = edition.initial
    ? []
    : [
        edition.added !== null ? `${n(edition.added)} added` : null,
        edition.updated !== null ? `${n(edition.updated)} updated` : null,
        edition.removed !== null ? `${n(edition.removed)} removed` : null,
      ].filter((part) => part !== null);
  if (edition.recordCount !== null) {
    return clauses.length > 0 ? `Since the previous edition: ${clauses.join(", ")}.` : null;
  }
  const head = `Latest edition (${formatEditionDate(edition.date)})`;
  return clauses.length > 0 ? `${head}: ${clauses.join(", ")}.` : `${head}.`;
}
