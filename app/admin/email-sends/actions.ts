"use server";

import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, verifySessionCookie } from "@/lib/admin-session";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { addressLookupAvailable, hashAddress } from "@/lib/email-sends";
import { ADDRESS_LOOKUP_LIMIT, listEmailSends } from "@/lib/email-sends-query";
import type { LookupState } from "@/app/admin/email-sends/lookup-state";

/**
 * Server Actions are independently callable (not gated by middleware page
 * render alone), so every action here re-verifies the admin session cookie
 * before doing anything. Mirrors app/admin/contact/actions.ts.
 */
async function assertAdminSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!verifySessionCookie(cookieValue)) {
    throw new Error("Unauthorized");
  }
}

const MAX_ADDRESS_LENGTH = 320;
const GENERIC_INVALID = "Enter an email address to look up.";
const LOOKUP_UNAVAILABLE = "Address lookup isn't available in this environment.";
const GENERIC_FAILURE = "The lookup could not be completed.";

/**
 * Finds the ledger rows for one address. A POST action rather than a GET
 * param so the address never reaches request logs or browser history. It is
 * hashed here and neither it nor its hash is returned, logged or put in an
 * error message; the result says only how many sends matched.
 */
export async function lookupEmailSendsAction(
  _previous: LookupState,
  formData: FormData
): Promise<LookupState> {
  await assertAdminSession();

  // Without the production salt every hash silently matches nothing; refuse instead of answering wrongly.
  if (!addressLookupAvailable()) return { message: LOOKUP_UNAVAILABLE, rows: [] };

  const raw = formData.get("address");
  const address = typeof raw === "string" ? raw.trim() : "";
  if (!address || address.length > MAX_ADDRESS_LENGTH || !address.includes("@")) {
    return { message: GENERIC_INVALID, rows: [] };
  }

  try {
    // The slice is defense in depth: the query already applies the same limit.
    const rows = (
      await listEmailSends(getDb(), { emailHash: hashAddress(address), limit: ADDRESS_LOOKUP_LIMIT })
    ).slice(0, ADDRESS_LOOKUP_LIMIT);
    return {
      message: `${rows.length} ${rows.length === 1 ? "send" : "sends"} for that address.`,
      rows: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
    };
  } catch (err) {
    // Code only: Drizzle errors embed bound params, which here include the address hash.
    console.error(`lookupEmailSendsAction failed (sqlstate: ${redactedErrorCode(err)})`);
    return { message: GENERIC_FAILURE, rows: [] };
  }
}
