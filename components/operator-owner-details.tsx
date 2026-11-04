import { SourceAnchor } from "@/components/facility/fact-row";
import type { OperatorOwner } from "@/lib/operator-ownership";

/** "Name" or "Name (part of Parent)". Built as one string so no JSX text chunk follows an interpolation. */
export function ownerDisplayName(owner: Pick<OperatorOwner, "name" | "parent">): string {
  return owner.parent ? `${owner.name} (part of ${owner.parent})` : owner.name;
}

/** "25% stake · since 2021-08", or "" when neither is recorded. */
export function ownerStakeLine(owner: Pick<OperatorOwner, "stakePct" | "since">): string {
  const parts: string[] = [];
  if (owner.stakePct != null) parts.push(`${owner.stakePct}% stake`);
  if (owner.since) parts.push(`since ${owner.since}`);
  return parts.join(" · ");
}

/**
 * Stake, note, "As of" and the source link for one operator-level owner.
 * The source is the owner row's own `source` — ownership rows cite their
 * own page, not an entry in any facility's `sources` — so it renders through
 * `SourceAnchor` rather than the index-based `SourceLink`.
 */
export function OperatorOwnerDetails({ owner }: { owner: OperatorOwner }) {
  const stakeLine = ownerStakeLine(owner);
  const sourceLabel = owner.source.publisher
    ? `${owner.source.label}, ${owner.source.publisher}`
    : owner.source.label;

  return (
    <>
      {stakeLine && (
        <span className="block normal-case tracking-normal text-muted-foreground">
          {stakeLine}
        </span>
      )}
      {owner.note && (
        <span className="block normal-case tracking-normal text-muted-foreground">
          {owner.note}
        </span>
      )}
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 normal-case tracking-normal text-xs text-muted-foreground">
        <span>As of {owner.asOf}</span>
        <SourceAnchor source={{ ...owner.source, label: sourceLabel }} />
      </span>
    </>
  );
}
