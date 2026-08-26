import { aiClassificationEnum } from "@/lib/schema";

export type AiClassification = (typeof aiClassificationEnum.options)[number];

/**
 * Label + description per AI-classification tier — mirrors the AI
 * classification explainer on /about and /ai.
 *
 * `satisfies Record<AiClassification, …>` is the exhaustiveness guard: adding
 * a member to `aiClassificationEnum` (`lib/schema.ts`) without adding an entry
 * here is a COMPILE error, not a silent `undefined` at lookup — this is the
 * guarantee `AI_CLASSIFICATION_ENTRIES` and `AI_CLASSIFICATION_CONFIDENCE_LABELS`
 * below are derived from.
 */
const TIERS = {
  confirmed: {
    label: "Confirmed",
    description:
      "The operator or a credible primary source explicitly describes the facility as an AI or GPU cluster — xAI Colossus, for example.",
  },
  likely: {
    label: "Likely",
    description:
      "The facility exhibits strong indicators — hyperscale GPU procurement, AI-specific power agreements — but has not been explicitly confirmed as AI-primary.",
  },
  mixed_use: {
    label: "Mixed use",
    description:
      "A multi-purpose campus where AI workloads are a known component but not necessarily the primary or exclusive use.",
  },
} satisfies Record<AiClassification, { label: string; description: string }>;

/**
 * Display order for the AI classification explainer — a deliberate editorial
 * ordering (confirmed → likely → mixed_use), not necessarily
 * `aiClassificationEnum`'s declaration order. `satisfies readonly
 * AiClassification[]` only checks VALIDITY (every key here is a real
 * `AiClassification`), not TOTALITY — a member present in `TIERS` but missing
 * here would still compile. `lib/ai-classification.test.ts` covers that gap
 * by asserting `AI_CLASSIFICATION_ENTRIES` (derived below, 1:1 map over this
 * array, same order) covers every `aiClassificationEnum` member.
 */
const TIER_ORDER = ["confirmed", "likely", "mixed_use"] as const satisfies readonly AiClassification[];

/** Display order + label/description for a facility's `aiClassification` tier — mirrors the AI classification explainer on /about and /ai. */
export const AI_CLASSIFICATION_ENTRIES = TIER_ORDER.map((key) => ({
  key,
  ...TIERS[key],
}));

/**
 * Confidence-tier labels for the aiClassification enum, for aggregate/breakdown
 * contexts where the page already establishes the AI framing (/ai, /stats,
 * /states/[state], the admin form). Per-facility contexts use
 * `AI_CLASSIFICATION_LABELS` (`lib/format.ts`), which is self-describing
 * ("AI-specific"). Derived from {@link TIERS} above so the two can never
 * drift; the `as` below is sound (not hiding a gap) because `TIERS` is itself
 * proven total by its `satisfies Record<AiClassification, …>` above —
 * re-exported from `lib/format.ts` for existing import sites.
 */
export const AI_CLASSIFICATION_CONFIDENCE_LABELS: Record<AiClassification, string> =
  Object.fromEntries(
    Object.entries(TIERS).map(([key, { label }]) => [key, label])
  ) as Record<AiClassification, string>;
