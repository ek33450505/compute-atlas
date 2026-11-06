import { sql } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import {
  maintenanceLedgerTable,
  operatorOwnershipTable,
  sitingContextTable,
} from "@/lib/db/schema";

/**
 * Keyed-JSON access for the closed-data tables (`siting_context`,
 * `operator_ownership`, `maintenance_ledger`) plus the backfill planner the
 * maintainer scripts share. Scripts take a `KeyedStore` so tests inject a fake;
 * only `neonStore` touches the database.
 */

export interface KeyedRow {
  key: string;
  data: unknown;
  /**
   * What to do when the key already exists. "update" (default) overwrites;
   * "nothing" leaves the existing row alone, for rows planned as MISSING: if
   * another writer inserted one mid-run it is not silently overwritten, and the
   * read-back verify then flags it if it differs from the source.
   */
  onConflict?: "update" | "nothing";
}

export interface KeyedStore {
  readAll(): Promise<Map<string, unknown>>;
  /** Per row: insert, or on a key clash overwrite `data` and bump `updated_at` (default) or leave it (`onConflict: "nothing"`). */
  upsert(rows: KeyedRow[]): Promise<void>;
}

/** Thrown for a deliberate, safe-to-print refusal (never wraps a DB error). */
export class RefusalError extends Error {}

/** Key order inside a jsonb value is not preserved by Postgres, so compare canonically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface UpsertPlan {
  insert: KeyedRow[];
  update: KeyedRow[];
  unchanged: number;
}

export function planUpsert(source: Map<string, unknown>, current: Map<string, unknown>): UpsertPlan {
  const plan: UpsertPlan = { insert: [], update: [], unchanged: 0 };
  for (const [key, data] of source) {
    if (!current.has(key)) plan.insert.push({ key, data });
    else if (!deepEqual(current.get(key), data)) plan.update.push({ key, data });
    else plan.unchanged += 1;
  }
  return plan;
}

export interface SyncReport {
  sourceCount: number;
  /** null when no store was available (dry run without DATABASE_URL). */
  plan: UpsertPlan | null;
  applied: boolean;
}

/** Re-reads `store` and throws unless every row in `expected` is present and deep-equal. */
export async function verifyRows(store: KeyedStore, expected: Map<string, unknown>, label: string): Promise<Map<string, unknown>> {
  const after = await store.readAll();
  const bad: string[] = [];
  for (const [key, data] of expected) {
    if (!after.has(key) || !deepEqual(after.get(key), data)) bad.push(key);
  }
  if (bad.length > 0) {
    throw new RefusalError(
      `${label}: read-back differs from source for ${bad.length} row(s) (first: ${bad.slice(0, 5).join(", ")}); refusing`,
    );
  }
  return after;
}

/**
 * One-time bootstrap of `source` into `store`. Dry run (apply=false) never
 * writes; with a null store it only reports the source count.
 *
 * With apply=true the plan is computed BEFORE any write, and the call refuses
 * if any existing row differs from the source: Neon is the truth once a row is
 * there, so a stale JSON must never revert it. (There is deliberately no force
 * flag.) Only missing rows are inserted, with ON CONFLICT DO NOTHING so a row
 * another writer adds mid-run is not overwritten (the read-back below flags it
 * if it differs), which makes a re-run idempotent. After the write it re-reads everything and refuses unless the table holds exactly
 * the source's keys and every row deep-equals its source.
 */
export async function syncKeyed(opts: {
  source: Map<string, unknown>;
  store: KeyedStore | null;
  apply: boolean;
  label: string;
}): Promise<SyncReport> {
  const { source, store, apply, label } = opts;
  if (store === null) {
    if (apply) throw new RefusalError(`${label}: --apply needs DATABASE_URL`);
    return { sourceCount: source.size, plan: null, applied: false };
  }
  const plan = planUpsert(source, await store.readAll());
  if (!apply) return { sourceCount: source.size, plan, applied: false };

  if (plan.update.length > 0) {
    throw new RefusalError(
      `${label}: Neon has moved ahead of the committed JSON; backfill refuses to overwrite ` +
        `${plan.update.length} existing row(s) (first: ${plan.update[0].key}); nothing was written`,
    );
  }

  await store.upsert(plan.insert.map((r) => ({ ...r, onConflict: "nothing" as const })));

  const after = await verifyRows(store, source, label);
  if (after.size !== source.size) {
    throw new RefusalError(
      `${label}: row count after write is ${after.size}, source has ${source.size}; refusing (investigate extra or missing rows)`,
    );
  }
  return { sourceCount: source.size, plan, applied: true };
}

export function formatReport(label: string, r: SyncReport): string {
  if (r.plan === null) return `${label}: source ${r.sourceCount}; no DATABASE_URL, would upsert ${r.sourceCount}`;
  const verb = r.applied ? "applied" : "dry run";
  const warn = !r.applied && r.plan.update.length > 0 ? "; --apply would REFUSE (Neon has moved ahead of the JSON)" : "";
  return `${label} (${verb}): source ${r.sourceCount}; insert ${r.plan.insert.length}, update ${r.plan.update.length}, unchanged ${r.plan.unchanged}${warn}`;
}

interface TableSpec {
  table: PgTable;
  key: PgColumn;
  data: PgColumn;
  updated: PgColumn;
  keyProp: string;
  dataProp: string;
  updatedProp: string;
}

const CHUNK = 500;

/** Any drizzle Postgres database: Neon HTTP in production, PGlite in tests. */
type AnyPgDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export function neonStoreFor(spec: TableSpec, db: AnyPgDb = getDb() as unknown as AnyPgDb): KeyedStore {
  return {
    async readAll() {
      const rows = await db.select({ k: spec.key, d: spec.data }).from(spec.table);
      return new Map(rows.map((r) => [r.k as string, r.d as unknown]));
    },
    async upsert(rows) {
      const queries = [];
      // Chunks are cut per conflict mode so one call (one batch) can mix both.
      for (const mode of ["nothing", "update"] as const) {
        const group = rows.filter((r) => (r.onConflict ?? "update") === mode);
        for (let i = 0; i < group.length; i += CHUNK) {
          const insert = db
            .insert(spec.table)
            .values(
              group.slice(i, i + CHUNK).map((r) => ({
                [spec.keyProp]: r.key,
                [spec.dataProp]: r.data,
              })),
            );
          queries.push(
            mode === "nothing"
              ? insert.onConflictDoNothing({ target: spec.key })
              : insert.onConflictDoUpdate({
                  target: spec.key,
                  set: {
                    [spec.dataProp]: sql.raw(`excluded."${spec.data.name}"`),
                    [spec.updatedProp]: sql`now()`,
                  },
                }),
          );
        }
      }
      if (queries.length === 0) return;
      // drizzle's neon-http `batch` sends every query through the driver's
      // `transaction` call, i.e. one HTTP request in ONE transaction: all chunks
      // land or none do (drizzle-orm 0.45.4 neon-http/session.js). Drivers
      // without `batch` (PGlite in tests) run the chunks one by one, where a
      // mid-way failure can leave some chunks written; a rerun completes it.
      const batch = (db as unknown as { batch?: (q: unknown[]) => Promise<unknown> }).batch;
      if (typeof batch === "function") {
        await batch.call(db, queries);
      } else {
        for (const q of queries) await q;
      }
    },
  };
}

export const sitingStore = (db?: AnyPgDb): KeyedStore =>
  neonStoreFor({
    table: sitingContextTable,
    key: sitingContextTable.facilityId,
    data: sitingContextTable.data,
    updated: sitingContextTable.updatedAt,
    keyProp: "facilityId",
    dataProp: "data",
    updatedProp: "updatedAt",
  }, db);

export const ownershipStore = (db?: AnyPgDb): KeyedStore =>
  neonStoreFor({
    table: operatorOwnershipTable,
    key: operatorOwnershipTable.operatorKey,
    data: operatorOwnershipTable.data,
    updated: operatorOwnershipTable.updatedAt,
    keyProp: "operatorKey",
    dataProp: "data",
    updatedProp: "updatedAt",
  }, db);

export const ledgerStore = (db?: AnyPgDb): KeyedStore =>
  neonStoreFor({
    table: maintenanceLedgerTable,
    key: maintenanceLedgerTable.key,
    data: maintenanceLedgerTable.value,
    updated: maintenanceLedgerTable.updatedAt,
    keyProp: "key",
    dataProp: "value",
    updatedProp: "updatedAt",
  }, db);
