// client-safe (only imports a type-only reference to lib/db/schema, which is
// erased at build time; no runtime import). Exists so "use client" components
// (app/admin/leads/lead-list.tsx) can import lead constants/types without
// dragging lib/leads.ts's server-only module graph (lib/db/client,
// lib/contribute -> lib/submissions -> lib/facility-write, which pulls in
// next/cache's revalidateTag, a Server-Component-only API) into the client
// bundle. lib/leads.ts re-exports these for existing server-side callers.
import type { LeadRow } from "@/lib/db/schema";

export const LEAD_STATUSES = ["new", "researching", "promoted", "dismissed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * Submit-time server-side fetch result, recorded by the Unit 2 POST /api/leads
 * handler after it fetches `url` once. Every field but `fetchedAt`/`ok` is
 * optional/nullable because the fetch itself can fail.
 */
export interface LeadTriage {
  fetchedAt: string; // ISO date
  ok: boolean; // did we reach it at all
  httpStatus?: number;
  finalUrl?: string; // after redirects
  title?: string; // <title>, trimmed
  contentType?: string;
  error?: string; // set when ok === false
  duplicateFacilityIds?: string[]; // live facilities already citing this URL
}

/**
 * The columns the admin leads screen actually renders. Deliberately excludes
 * `submitterIpHash` (a hashed submitter IP — pseudonymous personal data about
 * an anonymous member of the public): every field on a row passed from a
 * server component into a "use client" component crosses into the browser in
 * the RSC payload whether or not it's rendered in JSX, so an unprojected
 * `LeadRow[]` would ship the hash to the admin's browser unused. `lib/leads.ts`
 * selects an explicit column list matching this type (rather than stripping
 * fields after the fact), so a future column added to `leadsTable` can't
 * silently start leaking here too. `submitterIpHash` stays readable
 * server-side via the full `LeadRow` — `checkLeadRateLimit` in
 * lib/rate-limit.ts depends on it.
 */
export type AdminLeadRow = Pick<
  LeadRow,
  | "id"
  | "createdAt"
  | "url"
  | "note"
  | "attribution"
  | "status"
  | "triage"
  | "reviewNote"
  | "reviewedAt"
  | "promotedSubmissionId"
>;
