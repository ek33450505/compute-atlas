/**
 * Formats a dataset `asOf` timestamp for display, always in UTC so every
 * surface (/data, the /table export buttons) shows the same calendar date
 * regardless of the viewer's or server's time zone. Returns null for the
 * literal "unknown" (see lib/dataset-edition.ts's FALLBACK_EDITION) and for
 * unparseable values, so callers render nothing rather than "Invalid Date".
 *
 * Lives apart from lib/dataset-edition.ts so client components can import it
 * without bundling data/facilities.meta.json.
 */
export function formatAsOfDate(asOf: string, month: "long" | "short" = "long"): string | null {
  if (asOf === "unknown") return null;
  const date = new Date(asOf);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month,
    day: "numeric",
    timeZone: "UTC",
  });
}
