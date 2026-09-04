import type { ReactNode } from "react";

import { ExternalLink } from "lucide-react";

import type { Facility, Source } from "@/lib/schema";
import { safeExternalHref } from "@/lib/url";

// --- Source anchor (from an already-resolved Source) ---
// Shared by any facility-page section that renders a citation link once it
// already has the `Source` in hand — SourceLink below (resolves by index
// against `facility.sources`), and the status timeline (resolves by index
// against its own `sources` prop rather than a full `Facility`).
export function SourceAnchor({ source }: { source: Source }) {
  return (
    <a
      href={safeExternalHref(source.url)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${source.label} (opens in new tab)`}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
    >
      <ExternalLink className="size-3" aria-hidden="true" />
      {source.label}
    </a>
  );
}

// --- Source link helper ---
// Shared by any facility-page section that cites a `sources[]` entry by
// index (civic impact, stakeholders, subsidies, community, etc.).
export function SourceLink({
  sourceIndex,
  facility,
}: {
  sourceIndex?: number;
  facility: Facility;
}) {
  const source =
    sourceIndex !== undefined && sourceIndex < facility.sources.length
      ? facility.sources[sourceIndex]
      : null;
  if (!source) return null;
  return <SourceAnchor source={source} />;
}

// --- DT/DD pair helper (wrapped in div so CSS grid treats each pair as one item) ---
export function FactRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm tabular-nums">{children}</dd>
    </div>
  );
}

// --- Masthead-style fact grid (bordered card, mono/wide-tracking labels) ---
// Distinct visual flavor from FactRow above — used for the page masthead's
// "Key facts" card and the "Siting context" panel, both of which wrap the
// whole group in a bordered `neatline` card with font-mono uppercase
// labels, vs. FactRow's plain text-xs label used inside "Civic impact".
export function MastheadFactGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="neatline grid grid-cols-1 gap-x-8 gap-y-4 rounded-sm border border-border p-5 sm:grid-cols-2">
      {children}
    </dl>
  );
}

export function MastheadFactRow({
  label,
  valueClassName = "mt-1 text-sm",
  children,
}: {
  label: string;
  /** Overrides the `<dd>` className — most rows are plain text, some add `font-mono tabular-nums` for numeric/date values. */
  valueClassName?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className={valueClassName}>{children}</dd>
    </div>
  );
}

// --- Named group: heading + fact grid ---
// Shared shell for a titled `<dl>` of FactRow pairs — repeats across civic
// impact (Economics, Energy & water, Air permit, Mining, Environmental) and
// stakeholders (Ownership and financial interest, Public officials).
// `intro` renders between the heading and the grid for the two groups that
// carry an explanatory paragraph there (Air permit's regulatory-ceiling
// notice, Public officials' non-financial-interest caption) — everything
// else (trailing notes, source links, unit-group cards) stays at the call
// site as additional siblings, composed inside its own wrapper.
export function FactGroup({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {intro}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        {children}
      </dl>
    </div>
  );
}

// --- Meta line (secondary details joined by a spaced middot) ---
// Shared by any list-item card showing a row of secondary facts under a
// primary link/label (power links, related subsidies). Renders nothing
// when `parts` is empty, so callers can render it unconditionally.
export function MetaLine({ parts }: { parts: string[] }) {
  if (parts.length === 0) return null;
  return (
    <div className="text-muted-foreground text-xs mt-0.5">
      {parts.join(" · ")}
    </div>
  );
}
