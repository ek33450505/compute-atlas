/**
 * Dependency-free leaf module for `operatorSlug` — deliberately has zero
 * imports so both `lib/data.ts` (re-exports it for existing importers) and
 * `lib/cache-tags.ts` (needs it to build the `operator:*` tag, and must stay
 * free of `next/cache` so bare `tsx` CLIs can import it) can depend on it
 * without pulling in the Next.js runtime. Mirrors the existing
 * `lib/contribute-fields.ts` client-safe-leaf precedent.
 */

/** URL slug for an operator name, e.g. "Amazon Web Services" -> "amazon-web-services". */
export function operatorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
