import Link from "next/link";

import { SuggestCorrection } from "@/components/contribute/suggest-correction";
import { CORRECTABLE_KEYS, type CorrectableKey } from "@/lib/contribute-fields";
import { QUIET_ACTION_CLASS } from "@/lib/utils";

/**
 * Print-only nil marker. Every gap prompt below is `print:hidden` — it is an
 * affordance, useless on paper — which left the printed stat sheet rendering
 * a bare label over whitespace. On a document meant to be cited, a blank
 * reads as ZERO rather than UNKNOWN, so print says so explicitly.
 *
 * `hidden` is `display: none`, so the marker is absent from the screen
 * accessibility tree without an `aria-hidden` that would also silence it in
 * print. The print variant restores it for paper only. Kept quiet on the
 * page — it is a nil marker, not data. (`text-muted-foreground` is 6.70:1 on
 * parchment; see the contrast note on SECTION_LINK_CLASS below.)
 *
 * FIELD-level only, deliberately. It prints inline inside the `<dd>` of a
 * dt/dd pair, where the `<dt>` already carries the label, so the marker is
 * the bare words and reads as part of the grid. SECTION-level gaps have no
 * `<dt>` and each self-naming line printed as its own orphan sentence; they
 * are consolidated into one line at the foot of the brief instead — see
 * components/facility/print-gap-summary.tsx.
 */
function NotRecorded() {
  return (
    <span className="hidden text-muted-foreground print:inline">Not recorded</span>
  );
}

interface FieldGapPromptProps {
  /** Raw field key, e.g. "jobs" or "airPermit" — not assumed correctable. */
  field: string;
  facilityId: string;
  facilityName: string;
  /** Human copy, e.g. "permanent jobs", "the air permit". */
  label: string;
  /**
   * Set when this prompt stands in for a WHOLE group rather than one field —
   * it replaces the group's heading and list, so there is no `<dt>` beside it
   * and the print nil renders as a bare "Not recorded" naming nothing.
   *
   * The gap is NOT going unreported: the consolidated line at the foot of the
   * brief (components/facility/print-gap-summary.tsx) already names the group,
   * so the marker here is a duplicate as well as an orphan. Suppressing it
   * removes a repetition, never a fact.
   *
   * ⛔ Do not "restore" the marker for completeness — an unlabelled nil is the
   * defect this flag exists to prevent, and it is invisible in review because
   * it only shows in rendered output (found in a printed PDF, 2026-09-11).
   */
  coveredByPrintSummary?: boolean;
}

/**
 * Turns a silent empty-field gap into a working invite. Eligibility is
 * derived from membership in the imported CORRECTABLE_KEYS array — never a
 * second, hand-maintained list — so widening CORRECTABLE_KEYS (the deferred
 * water/energy/emissions/community/stakeholders fast-follow) lights up the
 * correction affordance here automatically, with zero changes to this file.
 */
export function FieldGapPrompt({
  field,
  facilityId,
  facilityName,
  label,
  coveredByPrintSummary = false,
}: FieldGapPromptProps) {
  const correctable = (CORRECTABLE_KEYS as readonly string[]).includes(field);
  // Both branches below carry the same marker, so the decision is made once
  // here — adding it to only one branch is how half a stat sheet gets printed.
  const printNil = coveredByPrintSummary ? null : <NotRecorded />;

  if (correctable) {
    return (
      <>
        <SuggestCorrection
          facilityId={facilityId}
          facilityName={facilityName}
          defaultField={field as CorrectableKey}
          showIntro={false}
          triggerLabel={`Know ${label}?`}
          triggerClassName={`${QUIET_ACTION_CLASS} print:hidden`}
        />
        {printNil}
      </>
    );
  }

  // Not (yet) correctable — route to the lighter lead form instead of
  // promising an edit the system can't apply automatically.
  return (
    <>
      <Link href="/contribute" className={`${QUIET_ACTION_CLASS} print:hidden`}>
        Know a source for {label} on {facilityName}? Send us a link.
      </Link>
      {printNil}
    </>
  );
}

interface SectionGapPromptProps {
  facilityName: string;
  /** Human copy, e.g. "economic impact data", "a documented stakeholder". */
  label: string;
}

// `text-muted-foreground` (#5C5344 on #F5F1E6) is 6.70:1 — see the contrast
// audit in app/globals.css. This used to carry `/70` opacity to read
// quieter than a populated section, but that composited to ~#8A8275 on
// #F5F1E6 = 3.36:1, below the 4.5:1 AA floor for normal text (WCAG 1.4.3).
// Full-opacity muted-foreground plus text-xs + italic still reads distinctly
// quieter than LINK_CLASS (text-sm, non-italic) without sacrificing AA.
const SECTION_LINK_CLASS =
  "text-xs italic text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Whole-section/whole-group gap — an entire group has no data at all (e.g.
 * every field in "Economics" is undefined, or a facility has no siting-
 * context entry), so there is no single field key to target a correction
 * at. Unlike FieldGapPrompt, this never does an eligibility check and
 * always renders the lead-path CTA. Render exactly one per empty group —
 * never one per hypothetical field inside it, which would be noise — and
 * keep it visually quieter (smaller, muted, italic) than a populated
 * section so an empty facility page doesn't read louder than a full one.
 *
 * Screen-only, and carries no print nil marker of its own: on paper the
 * sections it stands in for are named together in one consolidated line
 * (components/facility/print-gap-summary.tsx). Both read the SAME emptiness
 * predicates from lib/facility-gaps.ts, so the summary and the sections
 * cannot drift apart about what is missing.
 */
export function SectionGapPrompt({ facilityName, label }: SectionGapPromptProps) {
  return (
    <Link href="/contribute" className={`${SECTION_LINK_CLASS} print:hidden`}>
      Know a source for {label} on {facilityName}? Send us a link.
    </Link>
  );
}
