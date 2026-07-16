import { z } from "zod";
import { sourceSchema, statusEnum } from "@/lib/schema";
import type { Facility } from "@/lib/schema";

/**
 * Append-only status transition core.
 *
 * WHY append-only: the discovery "status refresh" bug rebuilt a facility's
 * full `sources` array from a compact projection, silently reordering or
 * shortening it. Any retained field carrying a `sourceIndex` (statusHistory
 * entries, `community`, `subsidies[]`, `jobs`) then pointed past the end of
 * the new array, and `facilitySchema`'s `checkSourceIndexBounds` rejected
 * the write (e.g. "community.sourceIndex 3 is out of range").
 *
 * This module never rewrites or reorders `existing.sources` — it only
 * appends new corroborating source(s) to the end and records the new
 * statusHistory entry's `sourceIndex` at the position of the first appended
 * source. Every pre-existing `sourceIndex` reference stays valid because the
 * array it points into only grows, never shrinks or reorders. The write
 * path still re-validates the result against `facilitySchema` as
 * defense-in-depth, but this function is designed to never trip that check.
 */
export const statusUpdateIntentSchema = z.object({
  status: statusEnum,
  date: z.string().min(4),
  note: z.string().optional(),
  sources: z.array(sourceSchema).min(1),
});

export type StatusUpdateIntent = z.infer<typeof statusUpdateIntentSchema>;

/**
 * Apply a status transition to a facility, append-only. Pure: does not
 * mutate `existing` and does not throw — callers validate the result
 * against `facilitySchema` if they need a hard guarantee.
 */
export function applyStatusUpdate(
  existing: Facility,
  intent: StatusUpdateIntent
): Facility {
  const appendedAt = existing.sources.length;
  const sources = [...existing.sources, ...intent.sources];
  const statusHistory = [
    ...(existing.statusHistory ?? []),
    {
      status: intent.status,
      date: intent.date,
      sourceIndex: appendedAt,
      ...(intent.note ? { note: intent.note } : {}),
    },
  ];

  const overrides = {
    status: intent.status,
    statusHistory,
    sources,
    lastUpdated: intent.date,
  };

  // Facility is a discriminatedUnion on facilityType. A spread of
  // `{...existing, ...overrides}` only touches shared base fields, but tsc
  // can lose the branch's literal `facilityType` narrowing across a plain
  // object spread of a union type. Switch on facilityType so each branch's
  // return type is inferred directly from that branch's object literal
  // rather than the union as a whole — no `as`/`as any` needed.
  switch (existing.facilityType) {
    case "data_center":
      return { ...existing, ...overrides };
    case "crypto_mining":
      return { ...existing, ...overrides };
    case "power_generation":
      return { ...existing, ...overrides };
  }
}
