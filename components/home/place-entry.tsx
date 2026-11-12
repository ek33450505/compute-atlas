import Link from "next/link";

import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";

export interface PlaceEntryProps {
  /** Jurisdiction codes that have records; each gets a state-hub option. */
  stateCodes: string[];
  className?: string;
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm border border-border bg-card px-3 font-mono text-xs uppercase tracking-wider text-foreground hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * "Start from a place": the visitor's own question ("what is being built near
 * me?") answered before the national story. The state picker is a plain
 * GET form to /states/go, which validates the code and 303s to the hub, so it
 * works without client JS. County and metro entry reuse the existing index
 * pages; the status chips link to the status hubs.
 */
export function PlaceEntry({ stateCodes, className }: PlaceEntryProps) {
  const options = stateCodes
    .flatMap((code) => {
      const name = stateNameFromCode(code);
      return name && stateSlugFromCode(code) ? [{ code: code.toUpperCase(), name }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section aria-labelledby="place-entry-heading" className={className}>
      <h2
        id="place-entry-heading"
        className="font-mono text-xs uppercase tracking-widest text-primary"
      >
        Start from a place
      </h2>
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-4">
        <form method="get" action="/states/go" className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="place-entry-state"
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              State
            </label>
            <select
              id="place-entry-state"
              name="state"
              defaultValue=""
              className="h-11 min-w-48 rounded-sm border border-border bg-card px-3 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <option value="">Choose a state</option>
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex h-11 items-center rounded-sm border border-primary bg-primary px-4 font-mono text-sm font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Show state
          </button>
        </form>

        <nav aria-label="Other places">
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link href="/counties" className={LINK_CLASS}>
                Browse counties
              </Link>
            </li>
            <li>
              <Link href="/metros" className={LINK_CLASS}>
                Browse metro areas
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <nav aria-label="Browse by status" className="mt-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Or by stage
        </p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {STATUS_ORDER.map((s) => (
            <li key={s}>
              <Link href={`/status/${s}`} className={LINK_CLASS}>
                {STATUS_META[s].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
