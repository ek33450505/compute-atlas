import { cache as reactCache } from "react";
import { unstable_cache } from "next/cache";
import { eq } from "drizzle-orm";

import ownershipRaw from "@/data/operator-ownership.json";
import { getDb, readsUseDatabase } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { operatorOwnershipTable } from "@/lib/db/schema";
import { operatorSlug } from "@/lib/operator-slug";
import {
  byOperator,
  operatorOwnerRoleEnum,
  operatorOwnerSchema,
  operatorOwnershipFileSchema,
  operatorOwnershipSchema,
  parseOperatorOwnership,
  type OperatorOwner,
  type OperatorOwnership,
} from "@/lib/operator-ownership-schema";

// The schema half lives in a JSON-free module so scripts/export.ts can load it before
// data/operator-ownership.json exists; re-exported so every importer is unchanged.
export {
  byOperator,
  operatorOwnerRoleEnum,
  operatorOwnerSchema,
  operatorOwnershipFileSchema,
  operatorOwnershipSchema,
  parseOperatorOwnership,
};
export type { OperatorOwner, OperatorOwnership };

/**
 * Operator-level ownership: who owns a whole operating company (Blackstone owns
 * QTS; KKR and GIP own CyrusOne). Kept apart from a facility's site-level
 * `stakeholders` on purpose: that field requires a source tying the stakeholder
 * to ONE site, and copying an operator's owners onto every facility would break
 * that standard. These rows render as "through the operator" and are never
 * counted as a site-level stake.
 *
 * Curated by the maintainer, like `stakeholders`; no public-intake or discovery
 * path writes it. Live reads come from the `operator_ownership` Neon table (see
 * the loaders below); the bundled JSON is parsed at module load and is only the
 * fallback, so a bad snapshot still fails the build and the tests.
 */

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

/**
 * The validated bundled snapshot of data/operator-ownership.json. ONLY the
 * fallback for a Neon throw, an empty or invalid result, or a read that may not
 * use the database. Components and pages must not import it: they receive
 * ownership by props from a loader below.
 */
export const operatorOwnership: OperatorOwnership[] = parseOperatorOwnership(ownershipRaw).sort(byOperator);

/** Storage seam: the Neon implementation below, a fake in tests. */
export interface OperatorOwnershipSource {
  /** The stored `data` for one operator, or undefined when it has no row. */
  one(operator: string): Promise<unknown | undefined>;
  /** The stored `data` of every row. */
  all(): Promise<unknown[]>;
}

export const neonOwnershipSource: OperatorOwnershipSource = {
  async one(operator) {
    const rows = await getDb()
      .select({ data: operatorOwnershipTable.data })
      .from(operatorOwnershipTable)
      .where(eq(operatorOwnershipTable.operatorKey, operator));
    return rows[0]?.data;
  },
  async all() {
    const rows = await getDb().select({ data: operatorOwnershipTable.data }).from(operatorOwnershipTable);
    return rows.map((r) => r.data);
  },
};

/** Thrown for a row that fails validation. Carries nothing: the rows are not ours to echo into logs. */
class InvalidRowError extends Error {
  constructor() {
    super("invalid operator_ownership row");
  }
}

function warnRead(what: string, err: unknown): void {
  // SQLSTATE only, never the error object (see lib/db-error.ts).
  const why = err instanceof InvalidRowError ? "returned an invalid row" : `failed (sqlstate: ${redactedErrorCode(err)})`;
  console.warn(`[operator-ownership] Neon ${what} ${why}, falling back to bundled JSON snapshot`);
}

// The `read*` functions return ONLY validated Neon data and THROW on a Neon
// error, an invalid row, or an empty table. They are what `unstable_cache`
// wraps: a thrown callback is never stored (next/dist/.../unstable-cache.js
// awaits the callback before `cacheNewResult`), so the snapshot can never be
// cached for 24h by one transient failure. The fallback lives only in the
// loaders and getters, OUTSIDE the cache.

/** One operator's validated Neon rows (`[]` when it has no row). Throws on an invalid row. */
async function readOperatorOwnership(operator: string, source: OperatorOwnershipSource): Promise<OperatorOwnership[]> {
  const data = await source.one(operator);
  // Neon is the source of truth: a missing row means "no owners", not the snapshot.
  if (data === undefined) return [];
  const parsed = operatorOwnershipSchema.safeParse(data);
  if (!parsed.success || parsed.data.operator !== operator) throw new InvalidRowError();
  return [parsed.data];
}

/** Every validated Neon row. Throws on an empty table or any invalid row. */
async function readAllOperatorOwnership(source: OperatorOwnershipSource): Promise<OperatorOwnership[]> {
  const rows = await source.all();
  if (rows.length === 0) throw new Error("operator_ownership table read returned no rows");
  const parsed = operatorOwnershipFileSchema.safeParse(rows);
  if (!parsed.success) throw new InvalidRowError();
  return parsed.data.sort(byOperator);
}

const snapshotFor = (operator: string): OperatorOwnership[] => operatorOwnership.filter((o) => o.operator === operator);

/**
 * The ownership rows for ONE operator (`[]` or a single row): Neon, else the
 * JSON snapshot on a throw or an invalid row. A missing row means no owners.
 * Validated before it is returned; unvalidated data never reaches a page.
 */
export async function loadOperatorOwnershipUncached(
  operator: string,
  source: OperatorOwnershipSource = neonOwnershipSource
): Promise<OperatorOwnership[]> {
  if (!readsUseDatabase()) return snapshotFor(operator);
  try {
    return await readOperatorOwnership(operator, source);
  } catch (err) {
    warnRead("read", err);
    return snapshotFor(operator);
  }
}

/** Every operator's ownership: Neon, else the JSON snapshot on a throw, empty or invalid result. */
export async function loadAllOperatorOwnershipUncached(
  source: OperatorOwnershipSource = neonOwnershipSource
): Promise<OperatorOwnership[]> {
  if (!readsUseDatabase()) return operatorOwnership;
  try {
    return await readAllOperatorOwnership(source);
  } catch (err) {
    warnRead("table read", err);
    return operatorOwnership;
  }
}

// `unstable_cache` needs the Next request-scoped cache context, absent under
// vitest: the getters degrade to the uncached loaders there, as lib/siting-context.ts does.
const cachedOne = (operator: string): Promise<OperatorOwnership[]> =>
  unstable_cache(() => readOperatorOwnership(operator, neonOwnershipSource), ["operator-ownership", operator], {
    // Scoped tag, not "facilities": the facility page must not re-acquire the
    // global tag (see lib/data.ts). 24h timer is the backstop.
    tags: [`operator:${operatorSlug(operator)}`],
    revalidate: 86400,
  })();

// Inside an RSC render, reactCache memoizes the promise (rejection included), so
// an outage costs at most one Neon read per request per key. Outside a render
// (and under vitest) it is a passthrough and gives no dedupe.
const requestScopedOne = reactCache(cachedOne);

/** Cached per-operator lookup (`[]` or one row), for the facility and operator pages. The fallback is applied outside the cache. */
export async function getOperatorOwnership(operator: string): Promise<OperatorOwnership[]> {
  if (process.env.VITEST || !readsUseDatabase()) return loadOperatorOwnershipUncached(operator);
  try {
    return await requestScopedOne(operator);
  } catch (err) {
    warnRead("read", err);
    return snapshotFor(operator);
  }
}

/** Owners of `operator` (exact match), or `[]`. Per-operator cached. */
export async function getOperatorOwners(operator: string): Promise<OperatorOwner[]> {
  return ownersFor(await getOperatorOwnership(operator), operator);
}

const cachedAll = reactCache(
  unstable_cache(() => readAllOperatorOwnership(neonOwnershipSource), ["operator-ownership", "all"], {
    // Whole table (~35KB): only for readers that already carry "facilities"
    // (the stakeholder index, built from loadFacilities).
    tags: ["facilities"],
    revalidate: 86400,
  })
);

/** Cached whole-table lookup. Only for pages that already carry the `facilities` tag. The fallback is applied outside the cache. */
export async function getAllOperatorOwnership(): Promise<OperatorOwnership[]> {
  if (process.env.VITEST || !readsUseDatabase()) return loadAllOperatorOwnershipUncached();
  try {
    return await cachedAll();
  } catch (err) {
    warnRead("table read", err);
    return operatorOwnership;
  }
}

export const OPERATOR_OWNER_ROLE_LABELS: Record<OperatorOwner["role"], string> = {
  controlling_owner: "Controlling owner",
  investor: "Investor",
};
