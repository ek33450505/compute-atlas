import type { Facility } from "@/lib/schema";
import type { SitingContext } from "@/lib/siting-context";
import { hasSitingContext } from "@/components/facility/siting-context";
import { hasPowerLinks } from "@/components/facility/power-links";
import { hasSiteStakeholders } from "@/components/facility/stakeholders";
import { capacityGapField, CORRECTABLE_KEYS, type CorrectableKey } from "@/lib/contribute-fields";
import { formatCapacity } from "@/lib/format";

/**
 * Single source of truth for "does this facility-page section have anything
 * to show?".
 *
 * The printed brief carries one consolidated nil line naming every empty
 * section (components/facility/print-gap-summary.tsx), and the sections
 * themselves each render their own contribute prompt when empty. Those two
 * must never disagree — a summary that names a section the page went on to
 * fill, or omits one it left blank, is worse than no summary. So the
 * predicates live here once and both callers import them; nothing re-derives
 * emptiness from the facility shape a second time.
 *
 * Three of the seven were already exported next to their sections and are
 * re-used as-is above. The four below were inline conditions inside
 * components/facility/civic-impact.tsx and were lifted here unchanged; that
 * file now imports them rather than repeating the checks.
 */

/** EconomicsGroup — investment, land, jobs. */
export function hasEconomics(facility: Facility): boolean {
  return !!(facility.investmentUsd || facility.landAcres || facility.jobs);
}

/** EnergyWaterGroup — energy source/utility/on-site generation, water. */
export function hasEnergyWater(facility: Facility): boolean {
  return !!(facility.energy || facility.water);
}

/**
 * A marked energy/water field must still render its "Not recorded" row even
 * when the facility has no energy or water object at all.
 */
export function hasEnergyWaterNotRecorded(facility: Facility): boolean {
  const marked = facility.notRecorded;
  return !!marked && (
    marked["energy.onSiteGenerationMw"] !== undefined ||
    marked["energy.source"] !== undefined ||
    marked["energy.utility"] !== undefined ||
    marked["water.coolingType"] !== undefined
  );
}

/**
 * The two predicates below are type guards rather than plain booleans so the
 * groups that call them keep the narrowing their inline conditions used to
 * give them — extending the type instead of casting at the use site.
 */
type FacilityWithEmissions = Facility & {
  emissions: NonNullable<Facility["emissions"]>;
};
type FacilityWithSubsidies = Facility & {
  subsidies: NonNullable<Facility["subsidies"]>;
};

/**
 * True when `permittedTpy` carries at least one defined pollutant limit.
 *
 * `!== undefined`, never truthy: a permit can state a 0.0 tpy limit for a
 * pollutant a unit is prohibited from emitting, and that zero is a real
 * regulatory fact the group renders.
 */
function hasAnyPermittedTpy(
  tpy: NonNullable<Facility["emissions"]>["permittedTpy"]
): boolean {
  return Object.values(tpy ?? {}).some((value) => value !== undefined);
}

/**
 * EmissionsGroup — air-permit limits.
 *
 * This is the group's FULL renderable-content test, not just a `!!emissions`
 * existence check. Every field in `emissionsSchema` is `.optional()` and its
 * `superRefine` only fires once `permittedTpy` carries a defined pollutant,
 * so `emissions: {}` is schema-valid — and a predicate that only asked
 * whether the object exists would report the section PRESENT while the group
 * rendered nothing at all, which is exactly the disagreement this module
 * exists to make impossible. (Latent, not live: 5 of 1,571 exported records
 * carry an `emissions` object and none of them is empty.) EmissionsGroup
 * calls this and keeps no second guard of its own, so there is nothing left
 * to drift.
 *
 * The group computes display labels first and tests those; this tests the
 * raw fields. The substitution is equivalent, and each half was checked:
 *   - `permitType`, `basis`, `averagingPeriod` are all `z.enum(...)` with no
 *     empty-string member, and their label maps hold no empty-string values,
 *     so `field ? (labels[field] ?? field) : null` is truthy exactly when the
 *     field is defined.
 *   - `permitNumber`, `issuingAgency`, `unitsCovered` are `.min(1)` strings;
 *     `issuedDate` and `notes` are not, but the group tests those raw too, so
 *     an empty string reads falsy on both sides alike.
 *   - `pollutantEntries.length > 0` filters `pollutantOrder` on
 *     `!== undefined`, which equals "any defined value in `permittedTpy`"
 *     ONLY because `pollutantOrder` is compile-time asserted exhaustive over
 *     `keyof PermittedTpy` (the `MissingFromOrder` check in
 *     components/facility/civic-impact.tsx). Deleting that assertion would
 *     reopen this hole one level down.
 *   - `sourceIndex` is deliberately excluded, matching the group: a citation
 *     with nothing to cite renders no panel.
 */
export function hasEmissions(facility: Facility): facility is FacilityWithEmissions {
  const emissions = facility.emissions;
  if (!emissions) return false;

  return !!(
    hasAnyPermittedTpy(emissions.permittedTpy) ||
    emissions.permitNumber ||
    emissions.permitType ||
    emissions.issuingAgency ||
    emissions.issuedDate ||
    emissions.notes ||
    emissions.basis ||
    emissions.unitsCovered ||
    emissions.averagingPeriod ||
    (emissions.unitGroups ?? []).length > 0
  );
}

/** SubsidiesGroup — documented public subsidies. */
export function hasSubsidies(facility: Facility): facility is FacilityWithSubsidies {
  return !!(facility.subsidies && facility.subsidies.length > 0);
}

/**
 * Print copy for each section, as NOUNS. The on-screen prompts phrase the
 * same gaps as mid-sentence fragments ("Know a source for *a public subsidy*
 * on X?"), which read badly in a list after a colon — that copy stays where
 * it is, on screen.
 *
 * A power_generation record's section is "Powers" (what it supplies), not
 * "Power supply" — printing the latter on a generator would assert the wrong
 * missing fact, so that one label is branch-dependent exactly as the screen
 * prompt's already is.
 */
function powerLabel(facility: Facility): string {
  return facility.facilityType === "power_generation"
    ? "powered campuses"
    : "power supply";
}

/**
 * Print labels for every section of the facility page that has no data, in
 * the page's own top-to-bottom order (siting context → power → the civic
 * impact groups → stakeholders).
 *
 * Async because `hasPowerLinks` has to query for linked facilities (unless the
 * caller passes the answer in).
 */
export async function missingSectionLabels(
  facility: Facility,
  siting: SitingContext | undefined,
  /** The page's already-resolved `hasPowerLinks(facility)`; queried here when omitted. */
  hasLinkedPower?: boolean
): Promise<string[]> {
  const sections: { label: string; present: boolean }[] = [
    { label: "siting context", present: hasSitingContext(siting) },
    { label: powerLabel(facility), present: hasLinkedPower ?? (await hasPowerLinks(facility)) },
    { label: "economic impact", present: hasEconomics(facility) },
    { label: "energy and water", present: hasEnergyWater(facility) },
    { label: "air permit", present: hasEmissions(facility) },
    { label: "public subsidies", present: hasSubsidies(facility) },
    { label: "stakeholders", present: hasSiteStakeholders(facility) },
  ];

  return sections.filter((s) => !s.present).map((s) => s.label);
}

/** notRecorded key for each correctable capacity field. */
export const CAPACITY_NOT_RECORDED_KEY = {
  capacityOperationalMw: "capacityMw.operational",
  capacityPlannedMw: "capacityMw.planned",
} as const;

/** Whether the facility page's civic-impact section renders at all. */
export function hasCivicImpact(facility: Facility): boolean {
  return !!(
    facility.energy ||
    facility.water ||
    hasEnergyWaterNotRecorded(facility) ||
    facility.emissions ||
    (facility.subsidies && facility.subsidies.length > 0) ||
    facility.investmentUsd ||
    facility.landAcres ||
    facility.jobs ||
    facility.community ||
    (facility.facilityType === "crypto_mining" && facility.mining) ||
    (facility.facilityType !== "power_generation" && facility.environmental)
  );
}

/** One thing the record lacks: `field` is set when a single field could fill it. */
export interface MissingRecordItem {
  field?: string;
  label: string;
}

/**
 * Everything the facility page used to prompt for on screen, as one ordered
 * list, so the "What this record is missing" card and the print summary read
 * the same predicates. Every section `missingSectionLabels` names appears here
 * (as the card's own wording), plus the field-level gaps inside populated
 * groups. Group-level gaps carry no field, except subsidies, which has one.
 *
 * Order follows the page's render order: the masthead's key facts (capacity,
 * powered by, announced), siting context, civic impact, stakeholders. The
 * power item sits at the masthead's powered-by position; it also stands in for
 * the power section further down, which is why a record missing both gets one
 * item rather than two.
 *
 * Stakeholders follow the print summary: site-level only (`hasSiteStakeholders`),
 * since operator owners are not a site-level record (#517).
 *
 * Power: a non-generator gets one item ("who powers it" when `poweredBy` is
 * missing, else "power supply" when no generator links it); a generator gets up
 * to two ("who powers it" and "what it powers").
 *
 * `hasLinkedPower` is the page's already-resolved `hasPowerLinks(facility)`.
 */
export function missingRecordItems(
  facility: Facility,
  siting: SitingContext | undefined,
  hasLinkedPower: boolean
): MissingRecordItem[] {
  const items: MissingRecordItem[] = [];

  const capacityField = capacityGapField(facility.status);
  if (
    formatCapacity(facility) === "—" &&
    facility.notRecorded?.[CAPACITY_NOT_RECORDED_KEY[capacityField]] === undefined
  ) {
    items.push({ field: capacityField, label: "capacity" });
  }

  const poweredByMissing = facility.poweredBy === undefined;
  if (facility.facilityType === "power_generation") {
    if (poweredByMissing) items.push({ field: "poweredBy", label: "who powers it" });
    if (!hasLinkedPower) items.push({ label: "what it powers" });
  } else if (poweredByMissing) {
    items.push({ field: "poweredBy", label: "who powers it" });
  } else if (!hasLinkedPower) {
    items.push({ label: "power supply" });
  }

  if (facility.announcedDate === undefined) items.push({ field: "announcedDate", label: "announcement date" });
  if (!hasSitingContext(siting)) items.push({ label: "siting context" });

  if (!hasEconomics(facility)) {
    items.push({ label: "economic impact (jobs, investment)" });
  } else {
    if (facility.investmentUsd === undefined) items.push({ field: "investmentUsd", label: "investment amount" });
    if (facility.landAcres === undefined) items.push({ field: "landAcres", label: "land area" });
    const j = facility.jobs;
    if (!(j && (j.construction !== undefined || j.permanent !== undefined))) {
      items.push({ field: "jobs", label: "jobs" });
    }
  }

  if (!hasEnergyWater(facility)) {
    // Same test as the print summary, so a record whose only energy/water
    // datum is a notRecorded marker is still listed there and here.
    items.push({ label: "energy or water data" });
  } else {
    if (
      facility.energy?.onSiteGenerationMw === undefined &&
      !facility.notRecorded?.["energy.onSiteGenerationMw"]
    ) {
      items.push({ field: "energy.onSiteGenerationMw", label: "on-site generation capacity" });
    }
    if (facility.water?.reportedMgd === undefined) {
      items.push({ field: "water.reportedMgd", label: "reported water use" });
    }
  }

  if (!hasEmissions(facility)) items.push({ label: "air permit" });
  if (!hasSubsidies(facility)) items.push({ field: "subsidies", label: "public subsidy" });

  if (!hasSiteStakeholders(facility)) items.push({ label: "a documented stakeholder" });

  return items;
}

function isCorrectableKey(field: string | undefined): field is CorrectableKey {
  return field !== undefined && (CORRECTABLE_KEYS as readonly string[]).includes(field);
}

/** First item whose field the correction dialog can pre-select, if any. */
export function firstCorrectableField(items: MissingRecordItem[]): CorrectableKey | undefined {
  for (const { field } of items) if (isCorrectableKey(field)) return field;
  return undefined;
}
