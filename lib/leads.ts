import { z } from "zod";
import { and, eq, desc, ne, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { facilitiesTable, leadsTable, submissionsTable, type LeadRow } from "@/lib/db/schema";
import { httpUrlSchema, sanitizeAttribution } from "@/lib/intake-fields";
import { facilitySchema } from "@/lib/schema";
import { createSubmission } from "@/lib/submissions";
import {
  LEAD_STATUSES,
  type LeadStatus,
  type LeadTriage,
  type AdminLeadRow,
  type StageLeadInput,
  type StageLeadResult,
} from "@/lib/lead-fields";

// Re-exported so existing server-side callers (app/admin/leads/page.tsx,
// app/admin/leads/actions.ts, this module's own tests) keep importing from
// "@/lib/leads" unchanged. Client components must import these from the
// client-safe "@/lib/lead-fields" leaf directly — see that file's header.
export {
  LEAD_STATUSES,
  type LeadStatus,
  type LeadTriage,
  type AdminLeadRow,
  type StageLeadInput,
  type StageLeadResult,
};

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
 * `checkIntakeRateLimit("leads", ipHash)` in lib/rate-limit.ts depends on it.
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
    // Conditional so a concurrent promote/dismiss between the read above and
    // this write cannot be overwritten (that would clobber the first
    // promotedSubmissionId or resurrect a dismissed lead).
    .where(
      and(eq(leadsTable.id, id), ne(leadsTable.status, "promoted"), ne(leadsTable.status, "dismissed"))
    )
    .returning();

  if (!updated) {
    return { ok: false, status: 409, error: "Lead changed — refresh and try again" };
  }
  return { ok: true, lead: updated };
}

/**
 * Returns a lead to `new` — the only way back into the discovery lane's queue
 * (`scripts/discovery/leads-lane.ts` queues `listLeadsForAdmin("new")` only, so
 * every other status is a one-way door out of it). Kept as a sibling of
 * `promoteLead` rather than an optional param on `updateLeadStatus` for the same
 * reason: this caller needs two behaviours the three admin triage actions must
 * NOT get, and both of them are hazards if a future edit drops them.
 *
 * 1. It CLEARS `promotedSubmissionId`. `promoteLead` is that column's only
 *    writer and it sets `status` and the id together, so a non-null id means a
 *    real staged submission exists. Re-queueing a lead with the id still set
 *    lets the lane stage a SECOND submission for the same site. Cleared in the
 *    same single `.set()` as `status`, so the two can never race apart.
 * 2. It NEVER destroys the prior `reviewNote`. `updateLeadStatus` writes
 *    `reviewNote ?? null`, which would erase the recorded reason a lead was
 *    dismissed (the UI calls this action with no note at all). With no new note
 *    the existing text is kept verbatim; with a new note the prior text is
 *    appended below it so the earlier reason stays readable. A bare `null` is
 *    only ever written over an already-null note.
 */
export async function resetLeadToNew(id: string, reviewNote?: string): Promise<LeadActionResult> {
  const db = getDb();
  const rows = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  if (row.status === "new") {
    return { ok: false, status: 409, error: "Lead already new" };
  }

  // Newest reason first (it is what the admin is acting on now), prior reason
  // retained below it. Never `reviewNote ?? null` — see hazard 2 above.
  // `?.trim() || undefined` collapses "" and whitespace-only to undefined:
  // an empty incoming note must fall back to the prior note, not erase it.
  const incomingNote = reviewNote?.trim() || undefined;
  const nextReviewNote =
    incomingNote && row.reviewNote
      ? `${incomingNote}\n\n(previous note: ${row.reviewNote})`
      : (incomingNote ?? row.reviewNote);

  const [updated] = await db
    .update(leadsTable)
    .set({
      status: "new",
      reviewedAt: new Date(),
      reviewNote: nextReviewNote,
      promotedSubmissionId: null,
    })
    .where(eq(leadsTable.id, id))
    .returning();

  return { ok: true, lead: updated };
}

/** Records the submit-time server-side fetch result against a lead. Used by POST /api/leads. */
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only admin path from a lead to the approve queue: stages a `pending`
 * submission built from a lead (plus the maintainer's researched payload) so
 * it is approved through the existing /admin/submissions flow. Staging only —
 * this never writes a live facility.
 *
 * The payload is validated against `facilitySchema` here (for an update, as the
 * shallow top-level merge `updateFacility` will perform) so a payload approve
 * would reject fails now rather than sitting in the queue. A create whose id
 * already exists 409s: that is the duplicate guard.
 *
 * `provenance.discoveredBy` is `lead:<id>` — the convention the hand-promoted
 * community leads already use, and the only link from a submission back to its
 * lead. A lead that is already promoted (one article covering several
 * facilities) may stage further submissions: its first `promotedSubmissionId`
 * is left alone and the extras are linked by `discoveredBy` alone.
 */
export async function stageLeadSubmission(
  leadId: string,
  input: StageLeadInput
): Promise<StageLeadResult> {
  if (!UUID_RE.test(leadId)) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  if (typeof input !== "object" || input === null) {
    return { ok: false, status: 400, error: "Invalid input" };
  }
  const db = getDb();
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) {
    return { ok: false, status: 404, error: "Lead not found" };
  }
  if (lead.status === "dismissed") {
    return { ok: false, status: 409, error: "Lead is dismissed — return it to new first" };
  }

  const payload = input.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, status: 400, error: "Payload must be a JSON object" };
  }
  const patch = payload as Record<string, unknown>;

  if (input.kind === "create") {
    const parsed = facilitySchema.safeParse(patch);
    if (!parsed.success) {
      return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
    }
    const existing = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, parsed.data.id));
    if (existing.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `Facility ${parsed.data.id} already exists — stage an update instead`,
      };
    }
    const pending = await db
      .select({ id: submissionsTable.id })
      .from(submissionsTable)
      .where(
        and(
          eq(submissionsTable.status, "pending"),
          eq(submissionsTable.kind, "create"),
          sql`${submissionsTable.payload}->>'id' = ${parsed.data.id}`
        )
      );
    if (pending.length > 0) {
      return {
        ok: false,
        status: 409,
        error: `A pending submission already proposes ${parsed.data.id}`,
      };
    }
  } else if (input.kind === "update") {
    const targetId = input.targetFacilityId?.trim();
    if (!targetId) {
      return { ok: false, status: 400, error: "targetFacilityId is required for an update" };
    }
    const [existing] = await db
      .select()
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, targetId));
    if (!existing) {
      return { ok: false, status: 404, error: "Facility not found" };
    }
    const parsed = facilitySchema.safeParse({ ...existing.doc, ...patch, id: targetId });
    if (!parsed.success) {
      return { ok: false, status: 400, error: "Invalid facility", issues: parsed.error.issues };
    }
  } else {
    return { ok: false, status: 400, error: "kind must be create or update" };
  }

  const extraSources = input.extraSources ?? [];
  for (const url of extraSources) {
    if (!httpUrlSchema.safeParse(url).success) {
      return { ok: false, status: 400, error: `Invalid source URL: ${url}` };
    }
  }
  const sources = [...new Set([lead.url, ...extraSources])];

  const note = input.note?.trim() || lead.note || undefined;
  const attribution = sanitizeAttribution(lead.attribution ?? undefined);
  const provenance = {
    sources,
    discoveredBy: `lead:${lead.id}`,
    discoveredAt: lead.createdAt.toISOString().slice(0, 10),
    ...(note ? { note } : {}),
    ...(attribution ? { attribution } : {}),
  };

  const created = await createSubmission({
    kind: input.kind,
    ...(input.kind === "update" ? { targetFacilityId: input.targetFacilityId?.trim() } : {}),
    payload: patch,
    provenance,
  });
  if (!created.ok) {
    return { ok: false, status: created.status, error: created.error, issues: created.issues };
  }

  let leadPromoted = false;
  if (lead.status !== "promoted") {
    // The submission already exists; a failed link must not report staging as failed.
    const promoted = await promoteLead(lead.id, created.id, `Staged as submission ${created.id}`);
    leadPromoted = promoted.ok;
  }
  return { ok: true, submissionId: created.id, leadPromoted };
}
