import type { ReactNode } from "react";

import { ExternalLink } from "lucide-react";

import type { Facility } from "@/lib/schema";
import { safeExternalHref } from "@/lib/url";

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
