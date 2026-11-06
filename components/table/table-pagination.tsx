import Link from "next/link";

import { cn } from "@/lib/utils";

interface TablePaginationProps {
  page: number;
  pageCount: number;
  /** Current query string (no leading "?"); every link keeps it, swapping only `page`. */
  query: string;
}

const itemClass =
  "inline-flex min-w-9 items-center justify-center rounded-sm border border-border px-2 py-1 font-mono text-xs";
const linkClass = cn(
  itemClass,
  "text-foreground transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
);

/** Page numbers to show: first, last, and a window around the current page; `null` marks a gap. */
export function pageWindow(page: number, pageCount: number): Array<number | null> {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  pages.forEach((n, i) => {
    if (i > 0 && n - pages[i - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/**
 * Previous/Next stay the same focusable link at the ends, marked
 * `aria-disabled`, so stepping onto the first/last page does not drop focus to
 * the body (WCAG 2.4.3). A disabled click is swallowed.
 */
function EndLink({
  label,
  rel,
  disabled,
  href,
}: {
  label: string;
  rel: "prev" | "next";
  disabled: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      rel={disabled ? undefined : rel}
      aria-disabled={disabled ? "true" : undefined}
      onClick={disabled ? (e) => e.preventDefault() : undefined}
      className={cn(linkClass, disabled && "cursor-not-allowed text-muted-foreground opacity-60")}
    >
      {label}
    </Link>
  );
}

export function TablePagination({ page, pageCount, query }: TablePaginationProps) {
  if (pageCount <= 1) return null;

  function href(n: number): string {
    const params = new URLSearchParams(query);
    if (n === 1) params.delete("page");
    else params.set("page", String(n));
    const qs = params.toString();
    return qs ? `/table?${qs}` : "/table";
  }

  return (
    <nav aria-label="Table pagination" className="flex flex-wrap items-center gap-2">
      <EndLink label="Previous" rel="prev" disabled={page <= 1} href={href(Math.max(1, page - 1))} />
      <ul className="flex flex-wrap items-center gap-1" role="list">
        {pageWindow(page, pageCount).map((n, i) =>
          n === null ? (
            <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-muted-foreground">
              …
            </li>
          ) : (
            <li key={n}>
              {n === page ? (
                <Link
                  href={href(n)}
                  aria-current="page"
                  aria-label={`Page ${n}`}
                  className={cn(linkClass, "bg-foreground text-background hover:bg-foreground")}
                >
                  {n}
                </Link>
              ) : (
                <Link href={href(n)} aria-label={`Page ${n}`} className={linkClass}>
                  {n}
                </Link>
              )}
            </li>
          )
        )}
      </ul>
      <EndLink
        label="Next"
        rel="next"
        disabled={page >= pageCount}
        href={href(Math.min(pageCount, page + 1))}
      />
    </nav>
  );
}
