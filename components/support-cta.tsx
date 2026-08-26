import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site";

const BASE_CLASS =
  "inline-flex h-11 items-center gap-2 rounded-md border px-5 font-mono text-sm font-semibold uppercase tracking-wider transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Ko-fi leads, so it gets the solid fill. */
const PRIMARY_CLASS = "border-primary bg-primary text-primary-foreground hover:bg-primary/90";

/** GitHub Sponsors stays, demoted to the outline treatment this CTA used to carry alone. */
const SECONDARY_CLASS = "border-primary bg-primary/10 text-primary hover:bg-primary/20";

interface SupportCtaProps {
  className?: string;
}

/**
 * The single place the accessible names for Compute Atlas's two funding
 * destinations live. Two links that both read "Sponsor" but point at
 * different targets would be exactly the kind of accessible-name collision
 * this project's accessibility conventions forbid — so Ko-fi and GitHub
 * Sponsors each get their own distinct, destination-specific accessible name
 * here, and every consumer of this component inherits it for free.
 */
export function SupportCta({ className }: SupportCtaProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <a
        href={siteConfig.kofiUrl}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Support Compute Atlas on Ko-fi (opens in new tab)"
        className={cn(BASE_CLASS, PRIMARY_CLASS)}
      >
        Support on Ko-fi <span aria-hidden="true">↗</span>
      </a>
      <a
        href={siteConfig.githubSponsorsUrl}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Sponsor Compute Atlas on GitHub Sponsors (opens in new tab)"
        className={cn(BASE_CLASS, SECONDARY_CLASS)}
      >
        Sponsor on GitHub <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
