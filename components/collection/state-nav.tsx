import Link from "next/link";

import { stateNameFromCode } from "@/lib/us-states";

export interface StateNavProps {
  /** Path the states link to, e.g. "/power". */
  basePath: string;
  /** Accessible name for the landmark, e.g. "Power projects by state". */
  label: string;
  /** [state code, row count] pairs, in display order. Only states with rows. */
  states: readonly (readonly [string, number])[];
  /** The state code being shown, if any. */
  current: string | null;
  /** Singular and plural noun for the count, e.g. ["project", "projects"]. */
  noun: readonly [string, string];
}

const ITEM =
  "flex min-h-8 items-center justify-between gap-2 rounded-sm border border-border px-3 py-1 text-sm text-foreground transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * By-state jump links. Each is a crawlable `<a href>` to `?state=xx`; only
 * states that hold at least one row are listed, so nothing leads to an empty page.
 */
export function StateNav({ basePath, label, states, current, noun }: StateNavProps) {
  return (
    <nav aria-label={label}>
      <ul className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3">
        {states.map(([code, count]) => (
          <li key={code}>
            <Link
              href={`${basePath}?state=${code.toLowerCase()}`}
              aria-current={code === current ? "page" : undefined}
              className={`${ITEM} ${code === current ? "bg-muted" : ""}`}
            >
              <span className="truncate">{stateNameFromCode(code) ?? code}</span>
              <span className="shrink-0 font-mono tabular-nums text-xs text-muted-foreground">
                {count} {count === 1 ? noun[0] : noun[1]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
