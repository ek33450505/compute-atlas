// client-safe leaf: only imports zod + built-in URL/regex. Safe for a "use
// client" component's module graph — must never import lib/db/client,
// lib/submissions, lib/contribute, or lib/facility-write (see
// lib/leads.ts and lib/lead-fields.ts for the failure mode this avoids).
import { z } from "zod";

// The single source of truth for the http/https URL refine — rejects
// javascript:/data: URLs at submit time, not just at facility-write time.
// lib/schema.ts's sourceSchema imports this directly (rather than keeping its
// own copy) for facility sources; the public-intake surfaces lib/contribute.ts
// (create/correction submissions) and lib/leads.ts (bare-URL tips) import this
// exact refine too, so no caller maintains its own copy.
export const httpUrlSchema = z.string().max(2000).url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "url must use the http or https protocol" }
);

// sanitizeAttribution
const LEADING_AT_RE = /^@+/; // drop any leading @
const ATTRIBUTION_DISALLOWED_RE = /[^A-Za-z0-9 _.\-]/g; // conservative allowlist: alnum, space, _ . -
const WHITESPACE_RUN_RE = /\s+/g; // collapse internal whitespace

/**
 * Normalizes an optional, public contributor handle for display. Rejects
 * anything email-like, strips to a conservative handle charset, hard-caps
 * length, and returns undefined for empty/invalid input so callers omit the
 * field entirely (anonymous stays the default).
 */
export function sanitizeAttribution(raw?: string): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(LEADING_AT_RE, "");
  if (s.includes("@")) return undefined; // reject emails / anything address-like
  s = s.replace(ATTRIBUTION_DISALLOWED_RE, "");
  s = s.replace(WHITESPACE_RUN_RE, " ").trim();
  s = s.slice(0, 40); // hard cap 40
  return s.length > 0 ? s : undefined;
}
