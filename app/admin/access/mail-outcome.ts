import type { GateDisposition } from "@/lib/email-gate";

export type MailKind = "approved" | "rejected" | "commercial_redirect" | "link_reissued";

export type MailOutcome = { delivered: boolean; text: string };

/** Plain-words cause for every disposition that is not `sent`. Exhaustive: a new disposition fails the build. */
function describeCause(disposition: Exclude<GateDisposition, "sent">): string {
  switch (disposition) {
    case "skipped_suppressed":
      return "the address has opted out of email";
    case "skipped_unconfirmed":
      return "the grant was no longer in the state this email requires";
    case "skipped_check_failed":
      return "the opt-out lookup failed, so nothing was sent";
    case "skipped_capped":
      return "a per-address email cap was reached";
    case "skipped_no_key":
      return "RESEND_API_KEY is not set";
    case "send_failed":
      return "the email provider reported a failure";
    case "gate_error":
      return "a database error stopped the send";
    default: {
      const unreachable: never = disposition;
      return unreachable;
    }
  }
}

const MAIL_NOUN: Record<MailKind, string> = {
  approved: "approval email",
  rejected: "rejection email",
  commercial_redirect: "paid-subscription email",
  link_reissued: "new-link email",
};

/**
 * What an admin action's email outcome means for the maintainer, in plain words.
 * `delivered: false` is the case the maintainer must act on, so its text names
 * the raw code and the consequence rather than just "failed".
 */
export function describeMailOutcome(disposition: GateDisposition, mail: MailKind): MailOutcome {
  if (disposition === "sent") {
    return { delivered: true, text: `The ${MAIL_NOUN[mail]} was sent.` };
  }
  const consequence =
    mail === "rejected" || mail === "commercial_redirect"
      ? "The requester was not told."
      : "The requester does NOT have their link. Reissue it from the grants list once the cause is fixed.";
  return {
    delivered: false,
    text: `The ${MAIL_NOUN[mail]} was NOT sent: ${describeCause(disposition)} (${disposition}). ${consequence}`,
  };
}
