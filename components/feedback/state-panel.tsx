import { cn } from "@/lib/utils";

interface StatePanelProps {
  /** Small mono eyebrow, e.g. "Error" / "404" / "No results". */
  eyebrow?: string;
  /** The main line. Rendered as the element given by `titleAs`. */
  title: string;
  /** Heading level for `title`. Full-page states pass "h1". Defaults to "h2". */
  titleAs?: "h1" | "h2" | "p";
  /** Supporting sentence(s) below the title. */
  description?: React.ReactNode;
  /** Optional row of buttons/links below the description. */
  actions?: React.ReactNode;
  /** Optional decorative mark above the eyebrow. Always rendered aria-hidden. */
  icon?: React.ReactNode;
  className?: string;
}

/**
 * Centered, atlas-styled panel for full-page states (error boundaries, 404)
 * and inline empty states (e.g. a filtered-out map). Purely presentational —
 * no data fetching, no routing. Callers decide semantics (heading level,
 * surrounding landmark/role).
 */
export function StatePanel({
  eyebrow,
  title,
  titleAs = "h2",
  description,
  actions,
  icon,
  className,
}: StatePanelProps) {
  const TitleTag = titleAs;

  return (
    <div
      className={cn(
        "mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-16 text-center sm:py-24",
        className
      )}
    >
      {icon && (
        <div aria-hidden="true" className="text-muted-foreground">
          {icon}
        </div>
      )}
      {eyebrow && (
        <p className="font-mono text-xs uppercase tracking-widest text-primary">
          {eyebrow}
        </p>
      )}
      <TitleTag
        className={cn(
          "font-display text-2xl text-foreground sm:text-3xl",
          titleAs === "h1" && "text-3xl sm:text-4xl"
        )}
      >
        {title}
      </TitleTag>
      {description && (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {actions && (
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          {actions}
        </div>
      )}
    </div>
  );
}
