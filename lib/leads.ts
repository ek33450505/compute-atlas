import { z } from "zod";
import { eq, desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { leadsTable, type LeadRow } from "@/lib/db/schema";
import { httpUrlSchema, sanitizeAttribution } from "@/lib/intake-fields";
import { LEAD_STATUSES, type LeadStatus, type LeadTriage, type AdminLeadRow } from "@/lib/lead-fields";

// Re-exported so existing server-side callers (app/admin/leads/page.tsx,
// app/admin/leads/actions.ts, this module's own tests) keep importing from
// "@/lib/leads" unchanged. Client components must import these from the
// client-safe "@/lib/lead-fields" leaf directly — see that file's header.
export { LEAD_STATUSES, type LeadStatus, type LeadTriage, type AdminLeadRow };

export const leadInputSchema = z.object({
  url: httpUrlSchema,
  note: z.string().max(500).optional(),
  attribution: z.string().max(80).optional(),
  website: z.string().max(200).optional(), // honeypot field; checked by the route before createLead
});

export type LeadInput = z.infer<typeof leadInputSchema>;

export type LeadResult =
  | { ok: true; id: string; url: string }
  | { ok: false; status: number; error: string; issues?: unknown };

export type LeadActionResult =
  | { ok: true; lead: LeadRow }
  | { ok: false; status: number; error: string };

/** Validates the envelope, sanitizes attribution, and inserts a new `new` lead row. */
export async function createLead(input: unknown, ipHash: string): Promise<LeadResult> {
  const parsed = leadInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid lead", issues: parsed.error.issues };
  }
  const { url, note } = parsed.data;
  const attribution = sanitizeAttribution(parsed.data.attribution);

  const db = getDb();
  const [row] = await db
    .insert(leadsTable)
    .values({
      url,
      note,
      attribution,
      submitterIpHash: ipHash,
    })
    .returning({ id: leadsTable.id });

  return { ok: true, id: row.id, url };
}

/**
 * The columns the admin leads screen actually renders. Deliberately excludes
 * `submitterIpHash` (a hashed submitter IP — pseudonymous personal data about
 * an anonymous member of the public): every field on a row passed from a
 * server component into a "use client" component crosses into the browser in
 * the RSC payload whether or not it's rendered in JSX, so an unprojected
 * `LeadRow[]` would ship the hash to the admin's browser unused. Selecting an
 * explicit column list (rather than stripping fields after the fact) means a
 * future column added to `leadsTable` can't silently start leaking here too.
 * `submitterIpHash` stays readable server-side via the full `LeadRow` —
 * `checkLeadRateLimit` in lib/rate-limit.ts depends on it.
 */
const ADMIN_LEAD_COLUMNS = {
  id: leadsTable.id,
  createdAt: leadsTable.createdAt,
  url: leadsTable.url,
  note: leadsTable.note,
  attribution: leadsTable.attribution,
  status: leadsTable.status,
  triage: leadsTable.triage,
  reviewNote: leadsTable.reviewNote,
  reviewedAt: leadsTable.reviewedAt,
  promotedSubmissionId: leadsTable.promotedSubmissionId,
} as const;

/** Lists leads for the admin triage UI, optionally filtered by status, newest first. */
export async function listLeadsForAdmin(status?: string): Promise<AdminLeadRow[]> {
  const db = getDb();
  const query = db.select(ADMIN_LEAD_COLUMNS).from(leadsTable);

  if (status && (LEAD_STATUSES as readonly string[]).includes(status)) {
    return query.where(eq(leadsTable.status, status)).orderBy(desc(leadsTable.createdAt));
  }
  return query.orderBy(desc(leadsTable.createdAt));
}

/**
 * Moves a lead between statuses, stamping reviewedAt. Rejects an unknown
 * status and 409s on a no-op transition to the lead's current status,
 * mirroring approveSubmission's already-decided guard.
 */
export async function updateLeadStatus(
  id: string,
  status: string,
  reviewNote?: string
): Promise<LeadActionResult> {
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, status: 400, error: `Unknown status: ${status}` };
  }

  const db = getDb();
  const rows = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  if (row.status === status) {
    return { ok: false, status: 409, error: `Lead already ${status}` };
  }

  const [updated] = await db
    .update(leadsTable)
    .set({ status, reviewedAt: new Date(), reviewNote: reviewNote ?? null })
    .where(eq(leadsTable.id, id))
    .returning();

  return { ok: true, lead: updated };
}

/**
 * Promotes a lead directly to `promoted`, recording the submission id it was
 * staged into. Used by the discovery leads-lane operator tool
 * (scripts/discovery/leads-lane.ts) after `createSubmission` succeeds — a
 * single update that sets `status` and `promotedSubmissionId` together, so
 * the two can never race apart into a lead marked promoted with no
 * submission id (or vice versa). Mirrors `updateLeadStatus`'s
 * not-found/already-that-status guards; kept as a sibling function rather
 * than an optional param on `updateLeadStatus` to avoid touching that
 * function's existing call sites (the three admin triage actions) for an
 * unrelated caller's need.
 */
export async function promoteLead(
  id: string,
  submissionId: string,
  reviewNote?: string
): Promise<LeadActionResult> {
  const db = getDb();
  const rows = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  if (row.status === "promoted") {
    return { ok: false, status: 409, error: "Lead already promoted" };
  }

  const [updated] = await db
    .update(leadsTable)
    .set({
      status: "promoted",
      reviewedAt: new Date(),
      reviewNote: reviewNote ?? null,
      promotedSubmissionId: submissionId,
    })
    .where(eq(leadsTable.id, id))
    .returning();

  return { ok: true, lead: updated };
}

/** Records the submit-time server-side fetch result against a lead. Used by Unit 2. */
export async function setLeadTriage(id: string, triage: LeadTriage): Promise<LeadActionResult> {
  const db = getDb();
  const rows = await db
    .update(leadsTable)
    .set({ triage })
    .where(eq(leadsTable.id, id))
    .returning();
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  return { ok: true, lead: row };
}
