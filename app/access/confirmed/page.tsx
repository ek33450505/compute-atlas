import type { Metadata } from "next";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { AccessNotOpen, AccessShell } from "../not-open";

export const metadata: Metadata = {
  title: "Request received",
  robots: { index: false, follow: false },
};

// Static: the flag is read at build time; a Vercel env change needs a redeploy (the interstitials are force-dynamic because they carry a token).
/** Landing page after /api/access/confirm succeeds. */
export default function AccessConfirmedPage() {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Request received" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Request received. Your address is confirmed and the request is in the review queue. Every
        request is reviewed by hand, usually within a few days, and the outcome is sent by email.
      </p>
    </AccessShell>
  );
}
