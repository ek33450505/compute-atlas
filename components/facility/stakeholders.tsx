import type { Facility } from "@/lib/schema";
import { Separator } from "@/components/ui/separator";

import { FactGroup, FactRow, SourceLink } from "./fact-row";

type Stakeholder = NonNullable<Facility["stakeholders"]>[number];

// Financial-interest / corporate-role / site-specific roles — grouped apart
// from `public_official` so a person's governmental role never reads as a
// financial stake in the site.
const FINANCIAL_INTEREST_ROLES = new Set<Stakeholder["role"]>([
  "founder",
  "controlling_owner",
  "investor",
  "executive",
  "board_member",
  "landowner",
]);

const ROLE_LABELS: Record<string, string> = {
  founder: "Founder",
  controlling_owner: "Controlling owner",
  investor: "Investor",
  executive: "Executive",
  board_member: "Board member",
  landowner: "Landowner",
  public_official: "Public official",
};

// --- Predicate ---
export function hasStakeholders(facility: Facility): boolean {
  return !!(facility.stakeholders && facility.stakeholders.length > 0);
}

// --- Stakeholder row ---
function StakeholderRow({
  facility,
  stakeholder,
}: {
  facility: Facility;
  stakeholder: Stakeholder;
}) {
  const label = ROLE_LABELS[stakeholder.role] ?? stakeholder.role;
  const nameLine = stakeholder.via
    ? `${stakeholder.name} via ${stakeholder.via}`
    : stakeholder.name;

  return (
    <FactRow label={label}>
      <span className="block normal-case tracking-normal">{nameLine}</span>
      {stakeholder.note && (
        <span className="block normal-case tracking-normal text-muted-foreground">
          {stakeholder.note}
        </span>
      )}
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 normal-case tracking-normal text-xs text-muted-foreground">
        <span>As of {stakeholder.asOf}</span>
        <SourceLink facility={facility} sourceIndex={stakeholder.sourceIndex} />
      </span>
    </FactRow>
  );
}

// --- Main export ---
export function StakeholdersSection({ facility }: { facility: Facility }) {
  if (!hasStakeholders(facility)) return null;

  const stakeholders = facility.stakeholders ?? [];
  const headingId = `stakeholders-${facility.id}`;

  const financial = stakeholders.filter((s) =>
    FINANCIAL_INTEREST_ROLES.has(s.role)
  );
  const officials = stakeholders.filter((s) => s.role === "public_official");

  return (
    <>
      <Separator />
      <section aria-labelledby={headingId} className="space-y-6">
        <h2 id={headingId} className="text-base font-semibold mb-4">
          Notable stakeholders
        </h2>

        {financial.length > 0 && (
          <FactGroup title="Ownership and financial interest">
            {financial.map((stakeholder, i) => (
              <StakeholderRow
                key={`${stakeholder.name}-${i}`}
                facility={facility}
                stakeholder={stakeholder}
              />
            ))}
          </FactGroup>
        )}

        {officials.length > 0 && (
          <FactGroup
            title="Public officials"
            intro={
              <p className="mb-3 text-sm text-muted-foreground">
                Officials with a documented role in this site&rsquo;s approval
                or funding. Listing here does not imply a financial interest.
              </p>
            }
          >
            {officials.map((stakeholder, i) => (
              <StakeholderRow
                key={`${stakeholder.name}-${i}`}
                facility={facility}
                stakeholder={stakeholder}
              />
            ))}
          </FactGroup>
        )}
      </section>
    </>
  );
}
