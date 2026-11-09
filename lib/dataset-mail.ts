import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { sendDatasetAdminNoticeGated, sendGrantGated, type GateResult } from "@/lib/email-gate";
import {
  sendDatasetAdminNewRequestEmail,
  sendDatasetAlreadyActiveEmail,
  sendDatasetVerifyEmail,
} from "@/lib/email";
import type { MailOf } from "@/lib/dataset-grants";

// These run inside `after()`, so nothing here may throw. The gates themselves never throw; the only
// throwing step is `getDb()` (e.g. DATABASE_URL unset), which is caught and reported as `gate_error`.
const gateError = (): GateResult => ({ sent: false, disposition: "gate_error" });

/** Requester-facing mail: the verify link, or the "you already have access" notice. */
export async function deliverDatasetRequestMail(
  intent: MailOf<"dataset_verify"> | MailOf<"dataset_already_active">
): Promise<GateResult> {
  try {
    const db = getDb();
    if (intent.kind === "dataset_verify") {
      return await sendGrantGated(
        db,
        { kind: "dataset_verify", grantId: intent.grantId, email: intent.email },
        () => sendDatasetVerifyEmail({ email: intent.email, verifyToken: intent.verifyToken, echo: intent.echo })
      );
    }
    return await sendGrantGated(
      db,
      { kind: "dataset_already_active", grantId: intent.grantId, email: intent.email },
      () => sendDatasetAlreadyActiveEmail({ email: intent.email })
    );
  } catch (err) {
    console.error(`dataset mail: request mail delivery failed (sqlstate: ${redactedErrorCode(err)})`);
    return gateError();
  }
}

/**
 * The maintainer alert. Call it ONCE per grant, on the verify -> pending_review transition: the gate does
 * not dedupe, and `verifyDatasetRequest` returns this intent only on that first transition.
 */
export async function deliverDatasetAdminNotice(
  intent: MailOf<"dataset_admin_new_request">
): Promise<GateResult> {
  try {
    return await sendDatasetAdminNoticeGated(
      getDb(),
      { grantId: intent.grantId, recipient: process.env.CONTACT_TO_EMAIL ?? "" },
      () => sendDatasetAdminNewRequestEmail({ name: intent.name, organization: intent.organization })
    );
  } catch (err) {
    console.error(`dataset mail: admin notice delivery failed (sqlstate: ${redactedErrorCode(err)})`);
    return gateError();
  }
}
