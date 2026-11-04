import { z } from "zod";

import ownershipRaw from "@/data/operator-ownership.json";
import { sourceSchema, stakeholderKindEnum } from "@/lib/schema";

/**
 * Operator-level ownership: who owns a whole operating company (Blackstone owns
 * QTS; KKR and GIP own CyrusOne). Kept apart from a facility's site-level
 * `stakeholders` on purpose: that field requires a source tying the stakeholder
 * to ONE site, and copying an operator's owners onto every facility would break
 * that standard. These rows render as "through the operator" and are never
 * counted as a site-level stake.
 *
 * Curated by the maintainer, like `stakeholders`; no public-intake or discovery
 * path writes it. The file is parsed at module load and throws on invalid data,
 * so a bad row fails the build and the tests instead of a page.
 *
 * Leaf module: no DB, no Next runtime.
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

/** Owners of `operator` (exact match), or `[]`. Pure half of `getOperatorOwners`. */
export function ownersFor(ownership: OperatorOwnership[], operator: string): OperatorOwner[] {
  return ownership.find((o) => o.operator === operator)?.owners ?? [];
}

export interface OwnedOperator {
  operator: string;
  owner: OperatorOwner;
}

/** Owner name -> the operators it owns a stake in. */
export function groupByOwner(ownership: OperatorOwnership[]): Map<string, OwnedOperator[]> {
  const byOwner = new Map<string, OwnedOperator[]>();
  for (const { operator, owners } of ownership) {
    for (const owner of owners) {
      const bucket = byOwner.get(owner.name);
      if (bucket) bucket.push({ operator, owner });
      else byOwner.set(owner.name, [{ operator, owner }]);
    }
  }
  return byOwner;
}

/** The validated contents of data/operator-ownership.json. */
export const operatorOwnership: OperatorOwnership[] = parseOperatorOwnership(ownershipRaw);

export function getOperatorOwners(operator: string): OperatorOwner[] {
  return ownersFor(operatorOwnership, operator);
}

export const OPERATOR_OWNER_ROLE_LABELS: Record<OperatorOwner["role"], string> = {
  controlling_owner: "Controlling owner",
  investor: "Investor",
};
