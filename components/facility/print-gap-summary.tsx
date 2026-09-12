import type { Facility } from "@/lib/schema";
import { missingSectionLabels } from "@/lib/facility-gaps";

/**
 * Print-only consolidated nil line.
 *
 * Field-level gaps print their marker inside the `<dd>` of a dt/dd pair, so
 * the `<dt>` beside them already says what is missing and a bare "Not
 * recorded" reads cleanly. A SECTION-level gap has no such label: it replaces
 * its own heading, so each one used to print its own self-naming line, and a
 * sparse record ended up with a run of four or five orphan sentences — enough
 * on the thinnest record to push it onto a second sheet of paper.
 *
 * One line at the foot of the brief says the same thing in a form a reader
 * can take in at a glance, and keeps the blank-reads-as-ZERO property that
 * made the markers necessary on a document meant to be cited.
 *
 * Renders nothing when every section has data — an absent line is correct
 * there, not a silent failure.
 *
 * The print visibility is not a `print:block` utility on this element: it is
 * the `display` in `[data-print-brief] > [data-print-gap-summary]`
 * (app/globals.css), which already carried this line's print type and
 * spacing. Unlike the bare "Not recorded" nil marker, this line names its own
 * subjects and would still READ fine somewhere else — it would just be wrong,
 * because the sections it names are a facility record's. Scoping it is about
 * blast radius and keeping one rule per print affordance, not legibility.
 */
export async function PrintGapSummary({ facility }: { facility: Facility }) {
  const missing = await missingSectionLabels(facility);
  if (missing.length === 0) return null;

  return (
    <p data-print-gap-summary className="hidden text-muted-foreground">
      Not recorded: {missing.join(", ")}.
    </p>
  );
}
