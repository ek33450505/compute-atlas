import { z } from "zod";

import { sourceSchema, stakeholderKindEnum } from "@/lib/schema";

/**
 * Operator-ownership schema, parse helper and sort order. Deliberately free of any
 * `data/*.json` import: `scripts/export.ts` loads it before those files exist (it is
 * what creates them). `lib/operator-ownership.ts` re-exports everything here.
 * Guarded by `lib/export-import-graph.test.ts`.
 */

export const operatorOwnerRoleEnum = z.enum(["controlling_owner", "investor"]);

const yearOrMonthSchema = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "since must be YYYY or YYYY-MM");

export const operatorOwnerSchema = z
  .object({
    /** One organization or person per row. */
    name: z.string().min(1),
    kind: stakeholderKindEnum,
    /** The group this owner belongs to, e.g. "BlackRock" for Global Infrastructure Partners. */
    parent: z.string().min(1).nullish(),
    role: operatorOwnerRoleEnum,
    stakePct: z.number().min(0).max(100).nullish(),
    since: yearOrMonthSchema.nullish(),
    /** One neutral sentence stating the documented relationship. */
    note: z.string().max(300).nullish(),
    source: sourceSchema,
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "asOf must be an ISO date (YYYY-MM-DD)"),
  })
  .superRefine((o, ctx) => {
    if (o.kind === "person" && o.parent) {
      ctx.addIssue({
        code: "custom",
        message: "a person cannot have a parent",
        path: ["parent"],
      });
    }
  });

export const operatorOwnershipSchema = z.object({
  /** EXACT `facility.operator` string. */
  operator: z.string().min(1),
  owners: z.array(operatorOwnerSchema).min(1),
});

export const operatorOwnershipFileSchema = z.array(operatorOwnershipSchema);

export type OperatorOwner = z.infer<typeof operatorOwnerSchema>;
export type OperatorOwnership = z.infer<typeof operatorOwnershipSchema>;

/** Parses and validates an ownership array; throws a ZodError on invalid data. */
export function parseOperatorOwnership(raw: unknown): OperatorOwnership[] {
  return operatorOwnershipFileSchema.parse(raw);
}

/**
 * Plain code-unit order by operator, the order `scripts/export.ts` writes. A
 * deterministic order keeps the first-wins owner-name slug map in lib/data.ts
 * (`slugToPerson`, which iterates ownership order) stable across builds; it
 * does not govern other names.
 */
export const byOperator = (a: OperatorOwnership, b: OperatorOwnership) =>
  a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0;
