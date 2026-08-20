import { siteConfig } from "@/lib/site";
import { cn } from "@/lib/utils";

interface WordmarkProps {
  showTagline?: boolean;
  className?: string;
}

export function Wordmark({ showTagline = false, className }: WordmarkProps) {
  return (
    <span className={cn("flex flex-col items-start gap-0", className)}>
      <span className="flex items-center gap-[9px]">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          className="wordmark-mark size-[19px] shrink-0 text-primary"
          shapeRendering="crispEdges"
        >
          <rect
            className="wordmark-plate-back"
            x="7.5"
            y="2.5"
            width="14"
            height="14"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.55"
          />
          <rect
            className="wordmark-plate-front"
            x="2.5"
            y="7.5"
            width="14"
            height="14"
            stroke="currentColor"
            strokeWidth="2"
          />
          <rect
            className="wordmark-datum"
            x="7.5"
            y="12.5"
            width="4"
            height="4"
            fill="currentColor"
          />
        </svg>
        <span className="font-mono text-[13px] font-semibold uppercase tracking-[0.11em] text-foreground leading-none">
          {siteConfig.name}
        </span>
      </span>
      {showTagline && (
        <span className="hidden lg:block font-mono text-[8.5px] uppercase tracking-[0.19em] text-muted-foreground leading-tight mt-0.5">
          Mapping the U.S. compute buildout
        </span>
      )}
    </span>
  );
}
