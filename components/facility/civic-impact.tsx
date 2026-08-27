import type { Facility } from "@/lib/schema";
import { Badge } from "@/components/ui/badge";
import { formatUsdCompact, formatTonsPerYear } from "@/lib/format";

import { FactRow, SourceLink } from "./fact-row";

// Shape of `facility.emissions.permittedTpy`, derived (not cast) from the
// schema so the pollutant table below stays in sync with `lib/schema.ts`.
type PermittedTpy = NonNullable<NonNullable<Facility["emissions"]>["permittedTpy"]>;

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

// Explicit display order — plain ASCII labels only (no Unicode subscripts)
// for screen-reader safety. `satisfies` (not a type annotation) rejects an
// invalid/misspelled key here while still preserving the literal tuple type
// the exhaustiveness check below needs.
const pollutantOrder = [
  "nox",
  "co",
  "pm25",
  "pm10",
  "so2",
  "voc",
  "co2e",
] as const satisfies readonly (keyof PermittedTpy)[];

// `Record<keyof PermittedTpy, string>` forces this object to cover every
// pollutant the schema defines — adding a pollutant to
// `emissionsSchema.permittedTpy` (lib/schema.ts) without adding its label
// here is a compile error.
const pollutantLabels: Record<keyof PermittedTpy, string> = {
  nox: "NOx",
  co: "CO",
  pm25: "PM2.5",
  pm10: "PM10",
  so2: "SO2",
  voc: "VOC",
  co2e: "CO2e",
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
    <div>
      <h3 className="text-sm font-semibold mb-3">Economics</h3>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {investmentUsd !== undefined && (
          <FactRow label="Investment">{formatUsdCompact(investmentUsd)}</FactRow>
        )}
        {landAcres !== undefined && (
          <FactRow label="Land">{landAcres.toLocaleString()} acres</FactRow>
        )}
        {jobsText && <FactRow label="Jobs">{jobsText}</FactRow>}
      </dl>
    </div>
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
      <h3 className="text-sm font-semibold mb-3">Energy &amp; water</h3>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
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
      </dl>
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

  const pollutantEntries = pollutantOrder
    .map((key) => ({ key, value: emissions.permittedTpy?.[key] }))
    .filter(
      (entry): entry is { key: keyof PermittedTpy; value: number } =>
        entry.value !== undefined
    );

  const hasContent =
    pollutantEntries.length > 0 ||
    !!emissions.permitNumber ||
    !!permitTypeLabel ||
    !!emissions.issuingAgency ||
    !!emissions.issuedDate ||
    !!emissions.notes;

  if (!hasContent) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3">Air permit</h3>
      <p className="text-sm text-muted-foreground mb-3">
        Permitted annual limits from this facility&apos;s air permit — a
        regulatory ceiling, not measured emissions.
      </p>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {pollutantEntries.map(({ key, value }) => (
          <FactRow key={key} label={pollutantLabels[key]}>
            {formatTonsPerYear(value)}
          </FactRow>
        ))}
        {emissions.permitNumber && (
          <FactRow label="Permit">{emissions.permitNumber}</FactRow>
        )}
        {permitTypeLabel && <FactRow label="Permit type">{permitTypeLabel}</FactRow>}
        {emissions.issuingAgency && (
          <FactRow label="Agency">{emissions.issuingAgency}</FactRow>
        )}
        {emissions.issuedDate && <FactRow label="Issued">{emissions.issuedDate}</FactRow>}
      </dl>
      {emissions.notes && (
        <p className="mt-2 text-sm text-muted-foreground">{emissions.notes}</p>
      )}
      {emissions.sourceIndex !== undefined && (
        <div className="mt-2">
          <SourceLink sourceIndex={emissions.sourceIndex} facility={facility} />
        </div>
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
    <div>
      <h3 className="text-sm font-semibold mb-3">Mining</h3>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
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
      </dl>
    </div>
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
      <div>
        <h3 className="text-sm font-semibold mb-3">Environmental</h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
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
        </dl>
      </div>
    );
  }

  // crypto_mining branch
  const { carbonIntensityProxy, carbonIntensityBasis } = facility.environmental;
  const basisLabel = carbonIntensityBasis
    ? (carbonIntensityBasisLabels[carbonIntensityBasis] ?? carbonIntensityBasis)
    : null;

  if (carbonIntensityProxy === undefined && !basisLabel) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold mb-3">Environmental</h3>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {carbonIntensityProxy !== undefined && (
          <FactRow label="Carbon proxy">{carbonIntensityProxy}</FactRow>
        )}
        {basisLabel && <FactRow label="Carbon basis">{basisLabel}</FactRow>}
      </dl>
    </div>
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
              {metaParts.length > 0 && (
                <div className="text-muted-foreground text-xs mt-0.5">
                  {metaParts.join(" · ")}
                </div>
              )}
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
  );
}
