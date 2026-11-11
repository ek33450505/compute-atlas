import { and, eq, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { liveGrant } from "@/lib/dataset-grants";
import { datasetAccessGrantsTable } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

/** Either the Neon HTTP client or PGlite in tests; the queries here use no transactions. */
export type CommercialDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The LIVE commercial grant of this address, if any, whose subscription is not `excludeSubscriptionId` (the
 * subscription being decided, so its own grant never counts against itself). Only `tier = 'commercial'` rows
 * count: a free grant never blocks a purchase. `email` must already be normalised by the caller
 * (`normalizeEmail`). The lowest id wins, so the id that feeds `conflict_grant_id` is deterministic.
 */
export async function findLiveCommercialGrant(
  db: CommercialDb,
  input: { email: string; excludeSubscriptionId?: string | null; now?: Date }
): Promise<{ grantId: string } | null> {
  const now = input.now ?? new Date();
  const [existing] = await db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(
      and(
        eq(datasetAccessGrantsTable.tier, "commercial"),
        eq(datasetAccessGrantsTable.email, input.email),
        liveGrant(now),
        input.excludeSubscriptionId
          ? or(
              sql`${datasetAccessGrantsTable.paypalSubscriptionId} is null`,
              ne(datasetAccessGrantsTable.paypalSubscriptionId, input.excludeSubscriptionId)
            )
          : undefined
      )
    )
    .orderBy(datasetAccessGrantsTable.id)
    .limit(1);
  return existing ? { grantId: existing.id } : null;
}
