"use client";

import { useState } from "react";

import { SuggestCorrection } from "@/components/contribute/suggest-correction";
import { CORRECTABLE_KEYS, type CorrectableKey } from "@/lib/contribute-fields";

interface ConfirmFactPromptProps {
  /** Raw field key, e.g. "capacityOperationalMw" — not assumed correctable. */
  field: string;
  facilityId: string;
  facilityName: string;
  /** Human copy naming the fact, e.g. "the capacity" — echoed in both
   *  controls' accessible names. */
  label: string;
  /** ISO date (YYYY-MM-DD) the fact was last confirmed, when reliably
   *  available at the call site (e.g. `facility.lastUpdated`). Renders
   *  honest, date-agnostic copy when omitted rather than inventing a
   *  vintage the call site can't back up. */
  vintage?: string;
}

const ACTION_CLASS =
  "text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Binary "still accurate?" prompt for a fact that is PRESENT but possibly
 * stale — the sibling of FieldGapPrompt (components/contribute/field-gap-
 * prompt.tsx), which handles a field that is MISSING. From the audit this
 * implements: "One line under a capacity figure: 'Read off a 2024 permit.
 * Still accurate?' with yes/no. A binary costs one click, needs no form, and
 * a 'no' is a research lead. Lowering the price of the first interaction is
 * what gets a second."
 *
 * "No" reuses the existing SuggestCorrection dialog, pre-targeted at
 * `field`, exactly the way FieldGapPrompt does it — no new write path.
 *
 * "Yes" is INTENTIONALLY a dead end: it flips local component state to a
 * thank-you and writes nothing. A one-click anonymous "confirm" endpoint is
 * a ballot-stuffing surface with no defense at this project's scale (no
 * accounts, and the only existing anti-abuse is the honeypot + rate limit on
 * POST /api/contribute), and it would buy nothing a correction doesn't
 * already cover — an anonymous click carries no source, so it can't move
 * `lastUpdated` or provenance forward the way a cited correction can. Do NOT
 * "complete" this by adding a POST endpoint for "Yes" without re-litigating
 * that tradeoff first.
 *
 * Eligibility is derived from CORRECTABLE_KEYS membership — never a second,
 * hand-maintained list (see FieldGapPrompt's doc comment for why a duplicate
 * of exactly this kind already drifted and shipped contradictory UI on
 * /gaps). A non-correctable field renders nothing rather than a dead end:
 * "No" would have nowhere to send the correction.
 */
export function ConfirmFactPrompt({
  field,
  facilityId,
  facilityName,
  label,
  vintage,
}: ConfirmFactPromptProps) {
  const correctable = (CORRECTABLE_KEYS as readonly string[]).includes(field);
  const [confirmed, setConfirmed] = useState(false);

  if (!correctable) return null;

  if (confirmed) {
    return (
      <p role="status" className="font-sans text-sm normal-nums text-muted-foreground">
        Thanks for confirming.
      </p>
    );
  }

  // Only the record's overall lastUpdated is reliably available at every
  // call site — there is no per-field sourceIndex for e.g. capacity to point
  // at a specific document's date. Naming that (rather than a fabricated
  // "permit" vintage) keeps the copy honest; see the module doc comment.
  const year = vintage?.slice(0, 4);
  const prompt = year ? `Last updated in ${year}. Still accurate?` : "Still accurate?";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans normal-nums">
      <span className="text-sm text-muted-foreground">{prompt}</span>
      <button
        type="button"
        aria-label={`Yes, ${label} is still accurate`}
        onClick={() => setConfirmed(true)}
        className={ACTION_CLASS}
      >
        Yes
      </button>
      <SuggestCorrection
        facilityId={facilityId}
        facilityName={facilityName}
        defaultField={field as CorrectableKey}
        showIntro={false}
        trigger={
          <button
            type="button"
            aria-label={`No, ${label} needs a correction`}
            className={ACTION_CLASS}
          >
            No
          </button>
        }
      />
    </div>
  );
}
