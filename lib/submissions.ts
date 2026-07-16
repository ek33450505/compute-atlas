import { z } from "zod";
import { eq, desc } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { submissionsTable, type SubmissionRow } from "@/lib/db/schema";
import { createFacility, updateFacility, writeStatusUpdate, type WriteResult } from "@/lib/facility-write";
import type { Facility } from "@/lib/schema";

const provenanceSchema = z.object({
  sources: z.array(z.string()).min(1), // ≥1 source — nothing stages uncited
  confidence: z.string().optional(),
  discoveredBy: z.string().min(1), // who/what proposed it (e.g. "data-wave:run-123" or "manual")
  runId: z.string().optional(),
  discoveredAt: z.string().optional(),
  note: z.string().optional(),
  submitterIpHash: z.string().optional(),
});

/**
 * Envelope-only validation at submit time — this is a human-in-the-loop
 * queue, so the pipeline may stage imperfect candidates. Full `facilitySchema`
 * validation happens at approve time via the Phase 3 write primitives.
 */
export const submissionInputSchema = z
  .object({
    kind: z.enum(["create", "update", "status_update"]),
    targetFacilityId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()), // full doc for create, partial patch/intent for update/status_update
    provenance: provenanceSchema,
  })
  .refine((s) => (s.kind !== "update" && s.kind !== "status_update") || !!s.targetFacilityId, {
    message: "targetFacilityId is required for update and status_update submissions",
    path: ["targetFacilityId"],
  });

export type SubmissionInput = z.infer<typeof submissionInputSchema>;

export type SubmissionResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string; issues?: unknown };

export type SubmissionActionResult =
  | { ok: true; submission: SubmissionRow; facility: Facility }
  | { ok: false; status: number; error: string; issues?: unknown };

export type SubmissionRejectResult =
  | { ok: true; submission: SubmissionRow }
  | { ok: false; status: number; error: string };

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;

/** Validates the envelope and inserts a new `pending` submission row. */
export async function createSubmission(input: unknown): Promise<SubmissionResult> {
  const parsed = submissionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid submission", issues: parsed.error.issues };
  }
  const { kind, targetFacilityId, payload, provenance } = parsed.data;

  const db = getDb();
  const [row] = await db
    .insert(submissionsTable)
    .values({ kind, targetFacilityId, payload, provenance })
    .returning({ id: submissionsTable.id });

  return { ok: true, id: row.id };
}

/** Lists submissions, optionally filtered by status, newest first. */
export async function listSubmissions(status?: string): Promise<SubmissionRow[]> {
  const db = getDb();
  const query = db.select().from(submissionsTable);

  if (status && (REVIEW_STATUSES as readonly string[]).includes(status)) {
    return query.where(eq(submissionsTable.status, status)).orderBy(desc(submissionsTable.createdAt));
  }
  return query.orderBy(desc(submissionsTable.createdAt));
}

/**
 * Promotes a pending submission to a live facility via the Phase 3 write
 * primitives, then marks the submission `approved`. If the primitive rejects
 * (e.g. schema-invalid payload), the submission is left `pending` so it can
 * be fixed and retried rather than silently lost.
 */
export async function approveSubmission(
  id: string,
  reviewNote?: string
): Promise<SubmissionActionResult> {
  const db = getDb();
  const rows = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  if (row.status !== "pending") {
    return { ok: false, status: 409, error: `Submission already ${row.status}` };
  }

  // `source: id` attributes the resulting facility_history row to this
  // submission rather than the "admin-direct" default, so promoted-submission
  // history correctly shows where the change came from.
  const writeResult: WriteResult =
    row.kind === "create"
      ? await createFacility(row.payload, id)
      : row.kind === "status_update"
        ? await writeStatusUpdate(row.targetFacilityId!, row.payload, id)
        : await updateFacility(row.targetFacilityId!, row.payload, id);

  if (!writeResult.ok) {
    return writeResult;
  }

  const [updated] = await db
    .update(submissionsTable)
    .set({ status: "approved", reviewedAt: new Date(), reviewNote: reviewNote ?? null })
    .where(eq(submissionsTable.id, id))
    .returning();

  return { ok: true, submission: updated, facility: writeResult.facility };
}

/** Rejects a pending submission with a required, non-empty reason. */
export async function rejectSubmission(
  id: string,
  reason: string
): Promise<SubmissionRejectResult> {
  if (!reason || !reason.trim()) {
    return { ok: false, status: 400, error: "reason is required" };
  }

  const db = getDb();
  const rows = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  if (row.status !== "pending") {
    return { ok: false, status: 409, error: `Submission already ${row.status}` };
  }

  const [updated] = await db
    .update(submissionsTable)
    .set({ status: "rejected", reviewedAt: new Date(), reviewNote: reason })
    .where(eq(submissionsTable.id, id))
    .returning();

  return { ok: true, submission: updated };
}
