import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { sendDatasetAdminNoticeGated, sendGrantGated, type GateResult } from "@/lib/email-gate";
import {
  sendDatasetAdminNewRequestEmail,
  sendDatasetAlreadyActiveEmail,
  sendDatasetApprovedEmail,
  sendDatasetCommercialRedirectEmail,
  sendDatasetLinkReissuedEmail,
  sendDatasetRejectedEmail,
  sendDatasetVerifyEmail,
} from "@/lib/email";
import type { MailOf } from "@/lib/dataset-grants";

// These run inside `after()` or an admin server action, so nothing here may throw. The gates themselves never
// throw; the only throwing step is `getDb()` (e.g. DATABASE_URL unset), which is caught and reported as
// `gate_error`.
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

/** Review-outcome mail: the access link on approval, the rejection notice, or a reissued link. */
export async function deliverDatasetReviewMail(
  intent:
    | MailOf<"dataset_approved">
    | MailOf<"dataset_rejected">
    | MailOf<"dataset_commercial_redirect">
    | MailOf<"dataset_link_reissued">
): Promise<GateResult> {
  try {
    const db = getDb();
    switch (intent.kind) {
      case "dataset_approved":
        return await sendGrantGated(
          db,
          { kind: "dataset_approved", grantId: intent.grantId, email: intent.email },
          () => sendDatasetApprovedEmail({ email: intent.email, accessToken: intent.accessToken })
        );
      case "dataset_rejected":
        return await sendGrantGated(
          db,
          { kind: "dataset_rejected", grantId: intent.grantId, email: intent.email },
          () => sendDatasetRejectedEmail({ email: intent.email, rejectionNote: intent.rejectionNote })
        );
      case "dataset_commercial_redirect":
        return await sendGrantGated(
          db,
          { kind: "dataset_commercial_redirect", grantId: intent.grantId, email: intent.email },
          () => sendDatasetCommercialRedirectEmail({ email: intent.email })
        );
      case "dataset_link_reissued":
        return await sendGrantGated(
          db,
          { kind: "dataset_link_reissued", grantId: intent.grantId, email: intent.email },
          () => sendDatasetLinkReissuedEmail({ email: intent.email, accessToken: intent.accessToken })
        );
    }
  } catch (err) {
    console.error(`dataset mail: review mail delivery failed (sqlstate: ${redactedErrorCode(err)})`);
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
      { grantId: intent.grantId, recipient: (process.env.CONTACT_TO_EMAIL ?? "").trim() },
      () => sendDatasetAdminNewRequestEmail({ name: intent.name, organization: intent.organization })
    );
  } catch (err) {
    console.error(`dataset mail: admin notice delivery failed (sqlstate: ${redactedErrorCode(err)})`);
    return gateError();
  }
}
