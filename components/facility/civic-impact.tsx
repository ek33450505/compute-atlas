import type { Facility } from "@/lib/schema";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatUsdCompact, formatTonsPerYear } from "@/lib/format";

import { FactGroup, FactRow, MetaLine, SourceLink } from "./fact-row";

// Shape of `facility.emissions.permittedTpy`, derived (not cast) from the
// schema so the pollutant table below stays in sync with `lib/schema.ts`.
type PermittedTpy = NonNullable<NonNullable<Facility["emissions"]>["permittedTpy"]>;

// Shape of one entry in `facility.emissions.unitGroups` — a per-equipment-
// group set of limits, for permits (Crusoe Abilene, xAI/MZX MS) that cap
// pollutants per group with different limits per group instead of one
// facility-wide number.
type EmissionsUnitGroup = NonNullable<NonNullable<Facility["emissions"]>["unitGroups"]>[number];

// --- Enum label maps ---
const energySourceLabels: Record<string, string> = {
  grid: "Grid",
  on_site_gas: "On-site gas",
  nuclear: "Nuclear",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  mixed: "Mixed",
  other: "Other",
};

const coolingTypeLabels: Record<string, string> = {
  evaporative: "Evaporative",
  air: "Air-cooled",
  closed_loop: "Closed-loop",
  hybrid: "Hybrid",
  unknown: "Unknown",
};

const communityStatusLabels: Record<string, string> = {
  supported: "Supported",
  mixed: "Mixed",
  contested: "Contested",
  opposed: "Opposed",
  litigation: "Litigation",
  unknown: "Unknown",
};

// Distinct enum from `water.coolingType` above (mining rigs use
// immersion/hydro cooling, not the data-center evaporative/closed-loop set)
// — do not merge with coolingTypeLabels.
const miningCoolingTypeLabels: Record<string, string> = {
  immersion: "Immersion",
  air: "Air-cooled",
  hydro: "Hydro",
  hybrid: "Hybrid",
  unknown: "Unknown",
};

const hardwareTypeLabels: Record<string, string> = {
  asic: "ASIC",
  gpu: "GPU",
  mixed: "Mixed",
  unknown: "Unknown",
};

const waterStressLabels: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extreme: "Extreme",
  unknown: "Unknown",
};

const carbonIntensityBasisLabels: Record<string, string> = {
  self_reported: "Self-reported",
  grid_average: "Grid average",
  estimated: "Estimated",
  unknown: "Unknown",
};

const permitTypeLabels: Record<string, string> = {
  psd: "PSD",
  title_v: "Title V",
  minor_source: "Minor source",
  state_construction: "State construction",
  other: "Other",
};

// Distinct from `permitTypeLabels` above — what the tonnages in
// `permittedTpy` apply to (facility total vs. a single unit's limit), not
// what kind of permit issued them.
const emissionsBasisLabels: Record<string, string> = {
  facility_wide: "Facility-wide",
  per_unit: "Per unit",
};

// Distinct enum from `emissionsBasisLabels` above — "group_wide" is a value
// that exists ONLY on an equipment group's own `basis` (a group entry always
// carries limits for something, so it never omits `basis`) and never on the
// top-level `emissions.basis`. Do not merge with emissionsBasisLabels.
const emissionsGroupBasisLabels: Record<EmissionsUnitGroup["basis"], string> = {
  per_unit: "Per unit",
  group_wide: "Group total",
};

const averagingPeriodLabels: Record<string, string> = {
  calendar_year: "Calendar year",
  rolling_12_month: "12-month rolling",
  other: "Other",
};

// Explicit display order — plain ASCII labels only (no Unicode subscripts)
// for screen-reader safety. `satisfies` (not a type annotation) rejects an
// invalid/misspelled key here while still preserving the literal tuple type
// the exhaustiveness check below needs.
const pollutantOrder = [
  "nox",
  "co",
  "pm",
  "pm10",
  "pm25",
  "so2",
  "voc",
  "co2e",
  "h2so4",
  "nh3",
  "formaldehyde",
  "hapsTotal",
] as const satisfies readonly (keyof PermittedTpy)[];

// `Record<keyof PermittedTpy, string>` forces this object to cover every
// pollutant the schema defines — adding a pollutant to
// `emissionsSchema.permittedTpy` (lib/schema.ts) without adding its label
// here is a compile error.
const pollutantLabels: Record<keyof PermittedTpy, string> = {
  nox: "NOx",
  co: "CO",
  pm: "PM",
  pm25: "PM2.5",
  pm10: "PM10",
  so2: "SO2",
  voc: "VOC",
  co2e: "CO2e",
  h2so4: "H2SO4",
  nh3: "NH3",
  formaldehyde: "Formaldehyde",
  hapsTotal: "Total HAPs",
};

// The Record above catches a missing LABEL; it can't catch `pollutantOrder`
// independently omitting a key that both exists in the schema and already
// has a label. Unlike lib/generation.ts's ORDER-tuple-defines-the-type
// pattern, the direction here is reversed: the Zod schema (via
// `PermittedTpy`) is authoritative, so `pollutantOrder` is checked for
// completeness AGAINST it, not the other way around. If a pollutant is ever
// added to the schema without adding it to `pollutantOrder`,
// `MissingFromOrder` stops being `never` and the assignment below fails to
// compile.
type MissingFromOrder = Exclude<keyof PermittedTpy, (typeof pollutantOrder)[number]>;
const pollutantOrderIsExhaustive: MissingFromOrder extends never ? true : MissingFromOrder =
  true;
void pollutantOrderIsExhaustive;

// Shared by the facility-wide `permittedTpy` and each equipment group's own
// `permittedTpy` — same ordering, same `!== undefined` check (a 0 tpy value
// is a real regulatory fact, never hidden by a truthy check).
function pollutantEntriesFor(tpy: PermittedTpy | undefined) {
  return pollutantOrder
    .map((key) => ({ key, value: tpy?.[key] }))
    .filter(
      (entry): entry is { key: keyof PermittedTpy; value: number } =>
        entry.value !== undefined
    );
}

// --- Predicate ---
export function hasCivicImpact(facility: Facility): boolean {
  return !!(
    facility.energy ||
    facility.water ||
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

// --- Sub-section: Economics ---
function EconomicsGroup({ facility }: { facility: Facility }) {
  const { investmentUsd, landAcres, jobs } = facility;
  if (!investmentUsd && !landAcres && !jobs) return null;

  const jobsText = (() => {
    if (!jobs) return null;
    const parts: string[] = [];
    if (jobs.construction) parts.push(`${jobs.construction.toLocaleString()} construction`);
    if (jobs.permanent) parts.push(`${jobs.permanent.toLocaleString()} permanent`);
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  return (
    <FactGroup title="Economics">
      {investmentUsd !== undefined && (
        <FactRow label="Investment">{formatUsdCompact(investmentUsd)}</FactRow>
      )}
      {landAcres !== undefined && (
        <FactRow label="Land">{landAcres.toLocaleString()} acres</FactRow>
      )}
      {jobsText && <FactRow label="Jobs">{jobsText}</FactRow>}
    </FactGroup>
  );
}

// --- Sub-section: Energy & water ---
function EnergyWaterGroup({ facility }: { facility: Facility }) {
  const { energy, water } = facility;
  if (!energy && !water) return null;

  const energySourceLabel = energy?.source
    ? (energySourceLabels[energy.source] ?? energy.source)
    : null;

  const coolingLabel = water?.coolingType
    ? (coolingTypeLabels[water.coolingType] ?? water.coolingType)
    : null;

  return (
    <div>
      <FactGroup title="Energy & water">
        {energySourceLabel && <FactRow label="Energy source">{energySourceLabel}</FactRow>}
        {energy?.utility && <FactRow label="Utility">{energy.utility}</FactRow>}
        {energy?.onSiteGenerationMw !== undefined && (
          <FactRow label="On-site generation">
            {energy.onSiteGenerationMw.toLocaleString()} MW
          </FactRow>
        )}
        {coolingLabel && <FactRow label="Cooling">{coolingLabel}</FactRow>}
        {water?.reportedMgd !== undefined && (
          <FactRow label="Water use">{water.reportedMgd.toLocaleString()} MGD</FactRow>
        )}
      </FactGroup>
      {energy?.notes && (
        <p className="mt-2 text-sm text-muted-foreground">{energy.notes}</p>
      )}
      {water?.notes && (
        <p className="mt-2 text-sm text-muted-foreground">{water.notes}</p>
      )}
    </div>
  );
}

// --- Sub-section: Air permit (emissions) ---
// `permittedTpy` values are regulatory CEILINGS from an air permit, never
// measured/actual emissions — the editorial line below is mandatory
// whenever this group renders. Every numeric check below is `!== undefined`,
// never truthy: a permit can legitimately state a 0.0 limit for a pollutant a
// unit is prohibited from emitting, and a truthy check would silently hide
// that real regulatory fact.
function EmissionsGroup({ facility }: { facility: Facility }) {
  const { emissions } = facility;
  if (!emissions) return null;

  const permitTypeLabel = emissions.permitType
    ? (permitTypeLabels[emissions.permitType] ?? emissions.permitType)
    : null;

  const pollutantEntries = pollutantEntriesFor(emissions.permittedTpy);

  const basisLabel = emissions.basis
    ? (emissionsBasisLabels[emissions.basis] ?? emissions.basis)
    : null;
  const averagingPeriodLabel = emissions.averagingPeriod
    ? (averagingPeriodLabels[emissions.averagingPeriod] ?? emissions.averagingPeriod)
    : null;

  const unitGroups = emissions.unitGroups ?? [];

  // Groups-only permits (e.g. xAI/MZX MS, which caps most pollutants only
  // per turbine group with no facility-wide tonnage at all) must still
  // render the panel — without this disjunct, a record with `unitGroups`
  // but no top-level pollutants/permit metadata would compute `hasContent`
  // false and the whole "Air permit" panel would silently render nothing.
  const hasContent =
    pollutantEntries.length > 0 ||
    !!emissions.permitNumber ||
    !!permitTypeLabel ||
    !!emissions.issuingAgency ||
    !!emissions.issuedDate ||
    !!emissions.notes ||
    !!basisLabel ||
    !!emissions.unitsCovered ||
    !!averagingPeriodLabel ||
    unitGroups.length > 0;

  if (!hasContent) return null;

  return (
    <div>
      <FactGroup
        title="Air permit"
        intro={
          <p className="text-sm text-muted-foreground mb-3">
            Permitted annual limits from this facility&apos;s air permit — a
            regulatory ceiling, not measured emissions.
          </p>
        }
      >
        {pollutantEntries.map(({ key, value }) => (
          <FactRow key={key} label={pollutantLabels[key]}>
            {formatTonsPerYear(value)}
          </FactRow>
        ))}
        {basisLabel && <FactRow label="Limits apply to">{basisLabel}</FactRow>}
        {emissions.unitsCovered && (
          <FactRow label="Units covered">{emissions.unitsCovered}</FactRow>
        )}
        {averagingPeriodLabel && (
          <FactRow label="Averaging period">{averagingPeriodLabel}</FactRow>
        )}
        {emissions.permitNumber && (
          <FactRow label="Permit">{emissions.permitNumber}</FactRow>
        )}
        {permitTypeLabel && <FactRow label="Permit type">{permitTypeLabel}</FactRow>}
        {emissions.issuingAgency && (
          <FactRow label="Agency">{emissions.issuingAgency}</FactRow>
        )}
        {emissions.issuedDate && <FactRow label="Issued">{emissions.issuedDate}</FactRow>}
      </FactGroup>
      {emissions.notes && (
        <p className="mt-2 text-sm text-muted-foreground">{emissions.notes}</p>
      )}
      {emissions.sourceIndex !== undefined && (
        <div className="mt-2">
          <SourceLink sourceIndex={emissions.sourceIndex} facility={facility} />
        </div>
      )}
      {unitGroups.length > 0 && (
        <div className="mt-4 space-y-4">
          {unitGroups.map((group) => (
            <EmissionsUnitGroupCard
              key={group.label}
              group={group}
              // A group without its own `averagingPeriod` inherits the
              // top-level one (per lib/schema.ts). Resolved and rendered
              // HERE, on the group, rather than once at panel level — a
              // groups-only record (item 1's xAI/MZX case) may have no
              // top-level averaging period row to point back to at all, and
              // a reader looking at one group's numbers shouldn't have to
              // cross-reference facility-wide metadata to know what window
              // they cover.
              averagingPeriodLabel={
                group.averagingPeriod
                  ? (averagingPeriodLabels[group.averagingPeriod] ?? group.averagingPeriod)
                  : averagingPeriodLabel
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One equipment group's own limits, rendered as its own heading + `<dl>`
// rather than nested inside the facility-wide `<dl>` above — a `<dl>` cannot
// validly contain another `<dl>` or a heading, so each group gets its own
// section instead of being interleaved into the parent list.
function EmissionsUnitGroupCard({
  group,
  averagingPeriodLabel,
}: {
  group: EmissionsUnitGroup;
  averagingPeriodLabel: string | null;
}) {
  const pollutantEntries = pollutantEntriesFor(group.permittedTpy);
  const basisLabel = emissionsGroupBasisLabels[group.basis] ?? group.basis;

  return (
    <div>
      <h4 className="text-xs font-semibold mb-2">{group.label}</h4>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {group.unitCount !== undefined && (
          <FactRow label="Units">{group.unitCount.toLocaleString()} units</FactRow>
        )}
        <FactRow label="Limits apply to">{basisLabel}</FactRow>
        {pollutantEntries.map(({ key, value }) => (
          <FactRow key={key} label={pollutantLabels[key]}>
            {formatTonsPerYear(value)}
          </FactRow>
        ))}
        {averagingPeriodLabel && (
          <FactRow label="Averaging period">{averagingPeriodLabel}</FactRow>
        )}
      </dl>
      {group.notes && (
        <p className="mt-2 text-sm text-muted-foreground">{group.notes}</p>
      )}
    </div>
  );
}

// --- Sub-section: Mining (crypto_mining branch only) ---
function MiningGroup({ facility }: { facility: Facility }) {
  if (facility.facilityType !== "crypto_mining") return null;
  const { mining } = facility;
  if (!mining) return null;

  const hardwareLabel = mining.hardwareType
    ? (hardwareTypeLabels[mining.hardwareType] ?? mining.hardwareType)
    : null;
  const coolingLabel = mining.coolingType
    ? (miningCoolingTypeLabels[mining.coolingType] ?? mining.coolingType)
    : null;
  const powerArrangementLabel = mining.powerArrangement
    ? mining.powerArrangement.replace(/_/g, " ")
    : null;

  if (
    mining.hashRateThPerS === undefined &&
    !hardwareLabel &&
    !coolingLabel &&
    !powerArrangementLabel
  ) {
    return null;
  }

  return (
    <FactGroup title="Mining">
      {mining.hashRateThPerS !== undefined && (
        <FactRow label="Hash rate">{mining.hashRateThPerS.toLocaleString()} TH/s</FactRow>
      )}
      {hardwareLabel && <FactRow label="Hardware">{hardwareLabel}</FactRow>}
      {coolingLabel && <FactRow label="Cooling">{coolingLabel}</FactRow>}
      {powerArrangementLabel && (
        <FactRow label="Power arrangement">
          <span className="capitalize">{powerArrangementLabel}</span>
        </FactRow>
      )}
    </FactGroup>
  );
}

// --- Sub-section: Environmental (both branches, different shapes) ---
function EnvironmentalGroup({ facility }: { facility: Facility }) {
  if (facility.facilityType === "power_generation" || !facility.environmental) {
    return null;
  }

  if (facility.facilityType === "data_center") {
    const { pue, pueConfidence, wue, gridCarbonIntensityGCo2PerKwh, renewablePercent, waterStress } =
      facility.environmental;
    const pueDisplay =
      pue !== undefined
        ? pueConfidence
          ? `${pue} PUE (${pueConfidence})`
          : `${pue} PUE`
        : null;
    const waterStressLabel = waterStressLabels[waterStress] ?? waterStress;

    return (
      <FactGroup title="Environmental">
        {pueDisplay && <FactRow label="PUE">{pueDisplay}</FactRow>}
        {wue !== undefined && <FactRow label="WUE">{wue}</FactRow>}
        {gridCarbonIntensityGCo2PerKwh !== undefined && (
          <FactRow label="Grid carbon intensity">
            {gridCarbonIntensityGCo2PerKwh.toLocaleString()} gCO2/kWh
          </FactRow>
        )}
        {renewablePercent !== undefined && (
          <FactRow label="Renewable">{renewablePercent}%</FactRow>
        )}
        <FactRow label="Water stress">{waterStressLabel}</FactRow>
      </FactGroup>
    );
  }

  // crypto_mining branch
  const { carbonIntensityProxy, carbonIntensityBasis } = facility.environmental;
  const basisLabel = carbonIntensityBasis
    ? (carbonIntensityBasisLabels[carbonIntensityBasis] ?? carbonIntensityBasis)
    : null;

  if (carbonIntensityProxy === undefined && !basisLabel) return null;

  return (
    <FactGroup title="Environmental">
      {carbonIntensityProxy !== undefined && (
        <FactRow label="Carbon proxy">{carbonIntensityProxy}</FactRow>
      )}
      {basisLabel && <FactRow label="Carbon basis">{basisLabel}</FactRow>}
    </FactGroup>
  );
}

// --- Sub-section: Public subsidies ---
function SubsidiesGroup({ facility }: { facility: Facility }) {
  const { subsidies } = facility;
  if (!subsidies || subsidies.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3">Public subsidies</h3>
      <ul className="space-y-3">
        {subsidies.map((subsidy, i) => {
          const amountDisplay =
            subsidy.amountUsd !== undefined
              ? formatUsdCompact(subsidy.amountUsd)
              : null;
          const metaParts: string[] = [];
          if (subsidy.jurisdiction) metaParts.push(subsidy.jurisdiction);
          if (subsidy.year) metaParts.push(subsidy.year);

          return (
            <li key={i} className="text-sm">
              <div>
                <span className="font-medium">{subsidy.program ?? "Subsidy"}</span>
                {amountDisplay && (
                  <span className="ml-2 tabular-nums">{amountDisplay}</span>
                )}
              </div>
              <MetaLine parts={metaParts} />
              {subsidy.sourceIndex !== undefined && (
                <div className="mt-0.5">
                  <SourceLink sourceIndex={subsidy.sourceIndex} facility={facility} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- Sub-section: Community sentiment ---
function CommunityGroup({ facility }: { facility: Facility }) {
  const { community } = facility;
  if (!community) return null;

  const statusLabel = community.status
    ? (communityStatusLabels[community.status] ?? community.status)
    : "Unknown";

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3">Community sentiment</h3>
      <div className="space-y-2">
        <Badge variant="outline">{statusLabel}</Badge>
        {community.notes && (
          <p className="text-sm text-muted-foreground">{community.notes}</p>
        )}
        {community.sourceIndex !== undefined && (
          <SourceLink sourceIndex={community.sourceIndex} facility={facility} />
        )}
      </div>
    </div>
  );
}

// --- Main export ---
export function CivicImpactSection({ facility }: { facility: Facility }) {
  if (!hasCivicImpact(facility)) return null;

  const headingId = `civic-impact-${facility.id}`;

  return (
    <>
      <Separator />
      <section aria-labelledby={headingId} className="space-y-6">
        <h2 id={headingId} className="text-base font-semibold mb-4">
          Civic impact
        </h2>
        <EconomicsGroup facility={facility} />
        <EnergyWaterGroup facility={facility} />
        <EmissionsGroup facility={facility} />
        <MiningGroup facility={facility} />
        <EnvironmentalGroup facility={facility} />
        <SubsidiesGroup facility={facility} />
        <CommunityGroup facility={facility} />
      </section>
    </>
  );
}
