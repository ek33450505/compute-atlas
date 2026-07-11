import Link from "next/link";

export interface Crumb {
  /** Visible label */
  label: string;
  /** Link target. Omit on the current (last) page. */
  href?: string;
}

interface BreadcrumbProps {
  items: Crumb[];
  className?: string;
}

/**
 * Accessible breadcrumb trail. Replaces the old single "← Back to X" links.
 * - <nav aria-label="Breadcrumb"> wrapping an ordered <ol>
 * - intermediate crumbs are <Link>s; the current (last) crumb is a non-link
 *   <span aria-current="page">
 * - "›" separators are aria-hidden (not announced by screen readers)
 */
export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-x-1.5 min-w-0">
              {isLast || !item.href ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className="text-foreground truncate max-w-[16rem]"
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                >
                  {item.label}
                </Link>
              )}
              {!isLast && (
                <span aria-hidden="true" className="text-border select-none">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
