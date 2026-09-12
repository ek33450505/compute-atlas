"use client";

import { useEffect, useState } from "react";

type PrintProvenanceFooterProps = {
  /** Facility display name, printed above the canonical URL. */
  name: string;
  /** Canonical record URL — pass the one the page already computed for JSON-LD. */
  url: string;
  /** ISO date the record was last curated (facility.lastUpdated). */
  lastUpdated: string;
};

/**
 * YYYY-MM-DD in the reader's own timezone.
 *
 * `toISOString().slice(0, 10)` would be the UTC calendar date, which is a
 * different day from about 8pm onward everywhere in the Americas — a US
 * reader printing on the evening of the 11th would get a document stamped
 * the 12th. The date is read off local getters rather than
 * `toLocaleDateString("en-CA")` so the ISO ordering is written here, not
 * inherited from a locale tag that happens to produce it. The format stays
 * YYYY-MM-DD because a citable record should not depend on the reader
 * knowing whether 05-09 is May or September.
 */
function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Print-only provenance footer: what a printed record needs to be citable —
 * where it came from, when the data was curated, when the paper was made, and
 * under what licence it may be reused.
 *
 * The printed date is filled CLIENT-SIDE on purpose. Facility pages are
 * `export const revalidate = false`, so a server-rendered `new Date()` would be
 * frozen at build time and every printout would claim a "Printed" date that is
 * really the deploy date — actively misleading on a document whose whole point
 * is citability. Filling it in an effect (and again on `beforeprint`, so a tab
 * left open overnight still prints today's date) means the value is either
 * correct or absent. With JS off the date simply does not render while the
 * URL, the record date and the licence still do: it degrades honestly.
 *
 * The print visibility is not a `print:block` utility on this element: it is
 * the `display` in `[data-print-brief] [data-print-provenance]`
 * (app/globals.css), alongside the rule that already gave this block its
 * border and type. Scoping matters more here than for any other print-only
 * block on the page — every line of it is an assertion about ONE record (its
 * name, its canonical URL, its curation date), so printed anywhere else it
 * would not merely be redundant or out of place, it would be false, on the
 * part of the document a reader is meant to cite.
 */
export function PrintProvenanceFooter({ name, url, lastUpdated }: PrintProvenanceFooterProps) {
  const [printedOn, setPrintedOn] = useState<string | null>(null);

  useEffect(() => {
    const stamp = () => setPrintedOn(localIsoDate(new Date()));
    stamp();
    window.addEventListener("beforeprint", stamp);
    return () => window.removeEventListener("beforeprint", stamp);
  }, []);

  return (
    <aside data-print-provenance className="hidden">
      <p>
        Compute Atlas — {name}
      </p>
      <p>{url}</p>
      <p>
        Record last updated {lastUpdated}
        {printedOn ? ` · Printed ${printedOn}` : null}
      </p>
      <p>Data licensed CC-BY-4.0 · https://creativecommons.org/licenses/by/4.0/</p>
    </aside>
  );
}
