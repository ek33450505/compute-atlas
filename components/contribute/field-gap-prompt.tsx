import Link from "next/link";

import { SuggestCorrection } from "@/components/contribute/suggest-correction";
import { CORRECTABLE_KEYS, type CorrectableKey } from "@/lib/contribute-fields";

interface FieldGapPromptProps {
  /** Raw field key, e.g. "jobs" or "airPermit" — not assumed correctable. */
  field: string;
  facilityId: string;
  facilityName: string;
  /** Human copy, e.g. "permanent jobs", "the air permit". */
  label: string;
}

const LINK_CLASS =
  "text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Turns a silent empty-field gap into a working invite. Eligibility is
 * derived from membership in the imported CORRECTABLE_KEYS array — never a
 * second, hand-maintained list — so widening CORRECTABLE_KEYS (the deferred
 * water/energy/emissions/community/stakeholders fast-follow) lights up the
 * correction affordance here automatically, with zero changes to this file.
 */
export function FieldGapPrompt({ field, facilityId, facilityName, label }: FieldGapPromptProps) {
  const correctable = (CORRECTABLE_KEYS as readonly string[]).includes(field);

  if (correctable) {
    return (
      <SuggestCorrection
        facilityId={facilityId}
        facilityName={facilityName}
        defaultField={field as CorrectableKey}
        showIntro={false}
        trigger={
          <button type="button" className={LINK_CLASS}>
            {`Know ${label}?`}
          </button>
        }
      />
    );
  }

  // Not (yet) correctable — route to the lighter lead form instead of
  // promising an edit the system can't apply automatically.
  return (
    <Link href="/contribute" className={LINK_CLASS}>
      Know a source for {label} on {facilityName}? Send us a link.
    </Link>
  );
}

interface SectionGapPromptProps {
  facilityName: string;
  /** Human copy, e.g. "economic impact data", "a documented stakeholder". */
  label: string;
}

const SECTION_LINK_CLASS =
  "text-xs italic text-muted-foreground/70 underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Whole-section/whole-group gap — an entire group has no data at all (e.g.
 * every field in "Economics" is undefined, or a facility has no siting-
 * context entry), so there is no single field key to target a correction
 * at. Unlike FieldGapPrompt, this never does an eligibility check and
 * always renders the lead-path CTA. Render exactly one per empty group —
 * never one per hypothetical field inside it, which would be noise — and
 * keep it visually quieter (smaller, muted, italic) than a populated
 * section so an empty facility page doesn't read louder than a full one.
 */
export function SectionGapPrompt({ facilityName, label }: SectionGapPromptProps) {
  return (
    <Link href="/contribute" className={SECTION_LINK_CLASS}>
      Know a source for {label} on {facilityName}? Send us a link.
    </Link>
  );
}
