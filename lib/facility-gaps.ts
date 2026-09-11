import type { Facility } from "@/lib/schema";
import { hasSitingContext } from "@/components/facility/siting-context";
import { hasPowerLinks } from "@/components/facility/power-links";
import { hasStakeholders } from "@/components/facility/stakeholders";

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
 * Async because `hasPowerLinks` has to query for linked facilities.
 */
export async function missingSectionLabels(facility: Facility): Promise<string[]> {
  const sections: { label: string; present: boolean }[] = [
    { label: "siting context", present: hasSitingContext(facility) },
    { label: powerLabel(facility), present: await hasPowerLinks(facility) },
    { label: "economic impact", present: hasEconomics(facility) },
    { label: "energy and water", present: hasEnergyWater(facility) },
    { label: "air permit", present: hasEmissions(facility) },
    { label: "public subsidies", present: hasSubsidies(facility) },
    { label: "stakeholders", present: hasStakeholders(facility) },
  ];

  return sections.filter((s) => !s.present).map((s) => s.label);
}
