import type { Facility } from "@/lib/schema";
import {
  OPERATOR_OWNER_ROLE_LABELS,
  getOperatorOwners,
  ownersFor,
  type OperatorOwner,
  type OperatorOwnership,
} from "@/lib/operator-ownership";
import { OperatorOwnerDetails, ownerDisplayName } from "@/components/operator-owner-details";
import { SectionGapPrompt } from "@/components/contribute/field-gap-prompt";
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
  "lender",
  "executive",
  "board_member",
  "landowner",
]);

const ROLE_LABELS: Record<string, string> = {
  founder: "Founder",
  controlling_owner: "Controlling owner",
  investor: "Investor",
  lender: "Lender",
  executive: "Executive",
  board_member: "Board member",
  landowner: "Landowner",
  public_official: "Public official",
};

// --- Predicates ---
/** True when the facility itself carries a site-level stakeholder (operator owners do not count). */
export function hasSiteStakeholders(facility: Facility): boolean {
  return !!(facility.stakeholders && facility.stakeholders.length > 0);
}

/**
 * Owners of the facility's operator, from the operator-level ownership layer.
 * `ownership` is injectable so tests can pass fixtures; the default reads the
 * validated data/operator-ownership.json.
 */
function operatorOwnersOf(facility: Facility, ownership?: OperatorOwnership[]): OperatorOwner[] {
  return ownership ? ownersFor(ownership, facility.operator) : getOperatorOwners(facility.operator);
}

/**
 * True when the section has anything to show: a site-level stakeholder OR an
 * owner of the operator. Drives the section's gap prompt and the print brief's
 * "Not recorded" list, both of which mirror what the page renders.
 */
export function hasStakeholders(facility: Facility, ownership?: OperatorOwnership[]): boolean {
  return hasSiteStakeholders(facility) || operatorOwnersOf(facility, ownership).length > 0;
}

// --- Vote direction ---
const VOTE_PATTERN = /\bvoted (for|against|yes|no)\b|\babstained\b/i;

/**
 * Splits a public official's note around the person's OWN vote direction: the
 * first `voted for|against|yes|no` (the direction word) or `abstained`. Later
 * matches are the body's tally, not this person's vote, so they are left alone.
 * Returns null when there is no match. before + direction + after === note.
 */
export function splitVoteDirection(
  note: string,
): { before: string; direction: string; after: string } | null {
  const match = VOTE_PATTERN.exec(note);
  if (!match) return null;
  const direction = match[1] ?? match[0];
  const start = match.index + match[0].length - direction.length;
  return {
    before: note.slice(0, start),
    direction,
    after: note.slice(start + direction.length),
  };
}

function VoteNote({ note }: { note: string }) {
  const split = splitVoteDirection(note);
  if (!split) return <>{note}</>;
  return (
    <>
      {split.before}
      <strong className="font-semibold text-foreground">{split.direction}</strong>
      {split.after}
    </>
  );
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
          {stakeholder.role === "public_official" ? (
            <VoteNote note={stakeholder.note} />
          ) : (
            stakeholder.note
          )}
        </span>
      )}
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 normal-case tracking-normal text-xs text-muted-foreground">
        <span>As of {stakeholder.asOf}</span>
        <SourceLink facility={facility} sourceIndex={stakeholder.sourceIndex} />
      </span>
    </FactRow>
  );
}

// --- Operator-level owner row ---
function OperatorOwnerRow({ owner }: { owner: OperatorOwner }) {
  return (
    <FactRow label={OPERATOR_OWNER_ROLE_LABELS[owner.role]}>
      <span className="block normal-case tracking-normal">{ownerDisplayName(owner)}</span>
      <OperatorOwnerDetails owner={owner} />
    </FactRow>
  );
}

// --- Main export ---
export function StakeholdersSection({
  facility,
  ownership,
}: {
  facility: Facility;
  /** Test seam: defaults to the real operator-ownership file. */
  ownership?: OperatorOwnership[];
}) {
  if (!hasStakeholders(facility, ownership)) {
    return (
      <SectionGapPrompt facilityId={facility.id} facilityName={facility.name} label="a documented stakeholder" />
    );
  }

  const stakeholders = facility.stakeholders ?? [];
  const headingId = `stakeholders-${facility.id}`;

  const financial = stakeholders.filter((s) =>
    FINANCIAL_INTEREST_ROLES.has(s.role)
  );
  const officials = stakeholders.filter((s) => s.role === "public_official");
  const operatorOwners = operatorOwnersOf(facility, ownership);

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

        {operatorOwners.length > 0 && (
          <FactGroup
            title="Through the operator"
            intro={
              <p className="mb-3 text-sm text-muted-foreground">
                {`${facility.operator} is owned as shown below. These stakes are held in the operating company, not documented for this site specifically.`}
              </p>
            }
          >
            {operatorOwners.map((owner) => (
              <OperatorOwnerRow key={owner.name} owner={owner} />
            ))}
          </FactGroup>
        )}
      </section>
    </>
  );
}
