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
 * print. Kept quiet on the page — it is a nil marker, not data.
 * (`text-muted-foreground` is 6.70:1 on parchment; see
 * the contrast audit in app/globals.css.)
 *
 * ⛔ The print visibility is NOT a `print:inline` utility on this element. It
 * lives in app/globals.css, scoped under `[data-print-brief]`, because the
 * marker is the bare words "Not recorded" and only means something where a
 * `<dt>` prints beside it — i.e. the facility brief. This component also
 * renders on /gaps, a page whose every row already IS a gap and which has no
 * `<dt>` anywhere: unscoped, it printed 36 bare markers across 7 pages there
 * (measured from a real PDF, 2026-09-11). Every other print rule in this
 * codebase is scoped that way; this was the one exception.
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
    <span data-print-nil className="hidden text-muted-foreground">
      Not recorded
    </span>
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
   * Facility page: the on-screen invite is gone (the gap is listed once on the
   * "What this record is missing" card), but the row stays so the printed
   * brief keeps its "Not recorded" nil beside the `<dt>`. Screen shows a quiet
   * dash labelled "Not recorded"; it does not print.
   */
  printOnly?: boolean;
}

/**
 * The "Know a source for …? Send us a link." invite for a gap with no field of
 * its own to correct. It opens the correction dialog on "Something else", so
 * the tip (still source-cited) is sent to the leads intake from right here,
 * with `label` as the topic, instead of sending the reader to another page.
 */
function TipPrompt({
  facilityId,
  facilityName,
  label,
  className,
}: {
  facilityId: string;
  facilityName: string;
  label: string;
  className: string;
}) {
  return (
    <SuggestCorrection
      facilityId={facilityId}
      facilityName={facilityName}
      defaultField="other"
      topic={label}
      intent="add"
      showIntro={false}
      triggerLabel={`Know a source for ${label} on ${facilityName}? Send us a link.`}
      // text-left: a <button> centres wrapped text, which the old inline link did not.
      triggerClassName={`${className} text-left print:hidden`}
    />
  );
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
  printOnly = false,
}: FieldGapPromptProps) {
  const correctable = (CORRECTABLE_KEYS as readonly string[]).includes(field);
  // Both branches below carry the same marker, so the decision is made once
  // here — adding it to only one branch is how half a stat sheet gets printed.
  const printNil = <NotRecorded />;

  if (printOnly) {
    return (
      <>
        {/* aria-label, not text: e2e/print-brief.spec.ts finds the print nil by
            its "Not recorded" text, and a second copy would be ambiguous. */}
        <span role="img" aria-label="Not recorded" className="text-muted-foreground print:hidden">
          {"\u2014"}
        </span>
        {printNil}
      </>
    );
  }

  if (correctable) {
    return (
      <>
        <SuggestCorrection
          facilityId={facilityId}
          facilityName={facilityName}
          defaultField={field as CorrectableKey}
          intent="add"
          showIntro={false}
          triggerLabel={`Know ${label}?`}
          triggerClassName={`${QUIET_ACTION_CLASS} text-left print:hidden`}
        />
        {printNil}
      </>
    );
  }

  // Not (yet) correctable — offer the tip path instead of promising an edit
  // the system can't apply automatically.
  return (
    <>
      <TipPrompt
        facilityId={facilityId}
        facilityName={facilityName}
        label={label}
        className={QUIET_ACTION_CLASS}
      />
      {printNil}
    </>
  );
}
