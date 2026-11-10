import Link from "next/link";

import { cn } from "@/lib/utils";

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
 * The on-site ask: an internal link to /support, where the Stripe Payment
 * Links live (`siteConfig.supportLinks`). Linking rather than embedding keeps
 * the payment options in one place, and the button never dead-ends while no
 * link is configured.
 */
export function SupportCta({ className, size = "default" }: SupportCtaProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <Link
        href="/support"
        className={cn(BASE_CLASS, size === "compact" && COMPACT_CLASS, PRIMARY_CLASS)}
      >
        Ways to support <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
