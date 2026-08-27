/**
 * Dependency-free leaf module for URL slug helpers — deliberately has zero
 * imports so both `lib/data.ts` (re-exports `operatorSlug`/`personSlug` for
 * existing importers) and `lib/cache-tags.ts` (needs `operatorSlug` to build
 * the `operator:*` tag, and must stay free of `next/cache` so bare `tsx`
 * CLIs can import it) can depend on it without pulling in the Next.js
 * runtime. Mirrors the existing `lib/contribute-fields.ts` client-safe-leaf
 * precedent.
 *
 * Serves two distinct entity kinds — operator names and stakeholder person
 * names — off the same slugging rule. `operatorSlug`/`personSlug` are thin
 * named wrappers around the shared `slugify` so call sites read clearly
 * about which entity they're slugging, even though the implementation is
 * identical today.
 */

/** Lowercases, collapses runs of non-alphanumerics to "-", trims leading/trailing "-". */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** URL slug for an operator name, e.g. "Amazon Web Services" -> "amazon-web-services". */
export function operatorSlug(name: string): string {
  return slugify(name);
}

/** URL slug for a stakeholder person's name, e.g. "Elon Musk" -> "elon-musk". */
export function personSlug(name: string): string {
  return slugify(name);
}
