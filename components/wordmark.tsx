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
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          className="wordmark-mark size-[18px] shrink-0 text-primary"
        >
          <rect
            className="wordmark-frame"
            x="4"
            y="4"
            width="16"
            height="16"
            rx="2"
            pathLength={1}
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <line className="wordmark-axis-v" x1="12" y1="4" x2="12" y2="20" pathLength={1} stroke="currentColor" strokeWidth="1.8" />
          <line className="wordmark-axis-h" x1="4" y1="12" x2="20" y2="12" pathLength={1} stroke="currentColor" strokeWidth="1.8" />
          <circle className="wordmark-datum" cx="12" cy="12" r="2.4" fill="currentColor" />
        </svg>
        <span className="font-display text-lg sm:text-xl font-semibold tracking-tight text-foreground leading-none">
          {siteConfig.name}
        </span>
      </span>
      {showTagline && (
        <span className="hidden sm:block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground leading-tight mt-0.5">
          Mapping the U.S. compute buildout
        </span>
      )}
    </span>
  );
}
