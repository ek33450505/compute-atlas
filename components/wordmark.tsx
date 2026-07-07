import { siteConfig } from "@/lib/site";
import { cn } from "@/lib/utils";

interface WordmarkProps {
  showTagline?: boolean;
  className?: string;
}

export function Wordmark({ showTagline = false, className }: WordmarkProps) {
  return (
    <span className={cn("flex flex-col items-start gap-0", className)}>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-primary text-base leading-none">
          ⌖
        </span>
        <span className="font-display text-lg sm:text-xl font-semibold tracking-tight text-foreground leading-none">
          {siteConfig.name}
        </span>
      </span>
      {showTagline && (
        <span className="hidden sm:block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground leading-tight mt-0.5">
          A survey of U.S. AI-datacenter infrastructure
        </span>
      )}
    </span>
  );
}
