import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { subscriptionsTable } from "@/lib/db/schema";
import { sendChangeNotification } from "@/lib/email";
import { STATUS_META } from "@/lib/status";
import type { Facility } from "@/lib/schema";

/**
 * Notifies every subscriber watching this facility that it changed. This is
 * the double-opt-in enforcement boundary: only `status='confirmed'` rows are
 * ever selected, so pending (unconfirmed) and unsubscribed rows never
 * receive mail (see lib/db/schema.ts subscriptionsTable comment and
 * lib/notify.integration.test.ts).
 *
 * Best-effort and never throws — a notification failure must not turn a
 * successful approval into an error. `sendChangeNotification` is already
 * non-throwing internally; the try/catch here is belt-and-suspenders around
 * the query itself (e.g. a transient DB error).
 */
export async function notifySubscribersOfChange(
  facility: Facility,
  changeLabel: string
): Promise<void> {
  try {
    const db = getDb();

    const rows = await db
      .select({
        email: subscriptionsTable.email,
        unsubscribeToken: subscriptionsTable.unsubscribeToken,
      })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.status, "confirmed"),
          eq(subscriptionsTable.targetType, "facility"),
          eq(subscriptionsTable.targetId, facility.id)
        )
      );

    const statusLabel = STATUS_META[facility.status].label;

    // NOTE (MVP scale, security-reviewed): sends run sequentially and inline within
    // approveSubmission, so a large confirmed-subscriber set slows the approve
    // response. Fine at current volumes; move to a queue / background send if
    // subscriber counts grow.
    for (const row of rows) {
      await sendChangeNotification({
        email: row.email,
        facilityName: facility.name,
        facilitySlug: facility.id,
        changeLabel,
        status: statusLabel,
        unsubscribeToken: row.unsubscribeToken,
      });
    }
  } catch (err) {
    // Never log email addresses or tokens here — only the error.
    console.error("notifySubscribersOfChange failed", err);
  }
}
