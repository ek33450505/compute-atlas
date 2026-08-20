import { z } from "zod";
import { eq, desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { leadsTable, type LeadRow } from "@/lib/db/schema";
import { httpUrlSchema, sanitizeAttribution } from "@/lib/contribute";

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

export const LEAD_STATUSES = ["new", "researching", "promoted", "dismissed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

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

/** Lists leads, optionally filtered by status, newest first. */
export async function listLeads(status?: string): Promise<LeadRow[]> {
  const db = getDb();
  const query = db.select().from(leadsTable);

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
