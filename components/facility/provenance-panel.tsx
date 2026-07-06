import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Facility } from "@/lib/schema";

interface ProvenancePanelProps {
  facility: Facility;
}

const CONFIDENCE_DESCRIPTIONS: Record<string, string> = {
  confirmed:
    "Confirmed: data verified against official filings, permits, or direct operator announcements.",
  reported:
    "Reported: data based on credible news outlets or industry sources.",
  rumored:
    "Rumored: data is unconfirmed and based on secondary or unverified sources.",
};

/**
 * Displays data provenance: confidence level, last-updated date, and a
 * full list of sources with external links.
 *
 * Accessibility contract:
 * - <section> with aria-labelledby references the visible heading
 * - Every source link includes "opens in new tab" in its aria-label
 * - Kind badge is text (never color-only)
 */
export function ProvenancePanel({ facility }: ProvenancePanelProps) {
  const headingId = `provenance-heading-${facility.id}`;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-base font-semibold">
        Sources &amp; data provenance
      </h2>

      <p className="text-sm text-muted-foreground">
        {CONFIDENCE_DESCRIPTIONS[facility.confidence]}
      </p>

      <p className="text-sm text-muted-foreground">
        Last updated:{" "}
        <time dateTime={facility.lastUpdated} className="tabular-nums">
          {facility.lastUpdated}
        </time>
      </p>

      <ul className="space-y-4" aria-label="Sources">
        {facility.sources.map((source, i) => (
          <li key={i} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${source.label} (opens in new tab)`}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                {source.label}
              </a>
              <Badge variant="outline" className="text-xs capitalize">
                {source.kind}
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {source.publisher && <span>{source.publisher}</span>}
              <span>
                Retrieved:{" "}
                <time dateTime={source.retrievedAt} className="tabular-nums">
                  {source.retrievedAt}
                </time>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
