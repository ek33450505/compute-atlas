import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site";

const BASE_CLASS =
  "inline-flex h-11 items-center gap-2 rounded-md border px-5 font-mono text-sm font-semibold uppercase tracking-wider transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const PRIMARY_CLASS = "border-primary bg-primary text-primary-foreground hover:bg-primary/90";

/** Compact trims height and padding so the button fits beside a link in a small card. */
const COMPACT_CLASS = "h-auto min-h-11 gap-1.5 px-3 text-xs tracking-normal sm:min-h-9";

interface SupportCtaProps {
  className?: string;
  /** Styling only: both sizes render the same link and the same label. */
  size?: "default" | "compact";
}

/**
 * The single on-site ask: Ko-fi, which takes guest checkout (no account),
 * card or PayPal, as a one-off gift or a monthly membership. GitHub Sponsors
 * remains only on the repository (.github/FUNDING.yml and the issue-template
 * contact link), not on the site.
 *
 * WCAG 2.5.3 (label in name): the aria-label STARTS with the visible text, so
 * speech-input users who say what they see hit the right control. The
 * trailing space sits inside the label string so SSR emits one text run
 * (no `<!-- -->` marker between the label and the arrow).
 */
export function SupportCta({ className, size = "default" }: SupportCtaProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <a
        href={siteConfig.kofiUrl}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Support on Ko-fi (opens in new tab)"
        className={cn(BASE_CLASS, size === "compact" && COMPACT_CLASS, PRIMARY_CLASS)}
      >
        Support on Ko-fi <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}
