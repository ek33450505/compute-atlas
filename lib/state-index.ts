/**
 * By-state paging for the long facility index pages (/power, /opposition).
 *
 * A sub-view is selected with `?state=` (a lowercase 2-letter code, e.g.
 * `?state=va`). Every state that holds a row is a plain link, so every
 * facility stays reachable from the index without JavaScript.
 */
import { stateNameFromCode } from "@/lib/us-states";

/**
 * Validates a raw `?state=` value against the codes that hold at least one
 * row. Returns the uppercase code, or `null` for a missing, repeated, or
 * unrecognised value so the caller falls back to the default view (200).
 */
export function parseStateParam(
  raw: string | string[] | undefined,
  available: ReadonlySet<string>
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // ASCII only: `toUpperCase` folds non-ASCII letters onto ASCII ("ı" -> "I"),
  // which would render a state at a non-canonical URL.
  if (!/^[A-Za-z]{2}$/.test(value)) return null;
  const code = value.toUpperCase();
  return available.has(code) && stateNameFromCode(code) ? code : null;
}

/**
 * Per-state row counts, as [code, count] sorted by state name A→Z. Counts only
 * codes `parseStateParam` can accept (uppercase, known jurisdiction), so every
 * nav link lands on its own sub-view and never on the default view.
 */
export function stateCounts(codes: Iterable<string>): [string, number][] {
  const counts = new Map<string, number>();
  for (const code of codes) {
    if (!/^[A-Z]{2}$/.test(code) || !stateNameFromCode(code)) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) =>
    (stateNameFromCode(a[0]) ?? a[0]).localeCompare(stateNameFromCode(b[0]) ?? b[0])
  );
}
