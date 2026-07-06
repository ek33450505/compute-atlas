import { z } from "zod";
import { STATUS_ORDER } from "@/lib/status";

export const statusEnum = z.enum(STATUS_ORDER);
export const aiClassificationEnum = z.enum(["confirmed", "likely", "mixed_use"]);
export const confidenceEnum = z.enum(["confirmed", "reported", "rumored"]);
export const sourceKindEnum = z.enum([
  "press",
  "permit",
  "osm",
  "iso_queue",
  "subsidy",
  "filing",
  "other",
]);

export const sourceSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1),
  publisher: z.string().optional(),
  retrievedAt: z.string().min(4),
  kind: sourceKindEnum.default("other"),
});

export const statusEventSchema = z.object({
  status: statusEnum,
  date: z.string().min(4),
  note: z.string().optional(),
  sourceIndex: z.number().int().nonnegative().optional(),
});

export const facilitySchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/, "id must be a lowercase kebab slug"),
    name: z.string().min(1),
    operator: z.string().min(1),
    status: statusEnum,
    aiClassification: aiClassificationEnum,
    confidence: confidenceEnum,
    location: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      city: z.string().optional(),
      county: z.string().optional(),
      state: z.string().length(2),
    }),
    capacityMw: z
      .object({
        planned: z.number().positive().optional(),
        operational: z.number().positive().optional(),
      })
      .optional(),
    poweredBy: z.string().optional(),
    announcedDate: z.string().optional(),
    statusHistory: z.array(statusEventSchema).default([]),
    sources: z.array(sourceSchema).min(1, "at least one source is required"),
    lastUpdated: z.string().min(4),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    data.statusHistory.forEach((event, eventIdx) => {
      if (
        event.sourceIndex !== undefined &&
        event.sourceIndex >= data.sources.length
      ) {
        ctx.addIssue({
          code: "custom",
          message: `statusHistory[${eventIdx}].sourceIndex ${event.sourceIndex} is out of range (sources has ${data.sources.length} item(s))`,
          path: ["statusHistory", eventIdx, "sourceIndex"],
        });
      }
    });
  });

export const facilitiesSchema = z.array(facilitySchema);

export type Facility = z.infer<typeof facilitySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type StatusEvent = z.infer<typeof statusEventSchema>;
