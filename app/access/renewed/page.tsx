import type { Metadata } from "next";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { AccessNotOpen, AccessShell } from "../not-open";

export const metadata: Metadata = {
  title: "Renewal requested",
  robots: { index: false, follow: false },
};

// Static: the flag is read at build time; a Vercel env change needs a redeploy (the interstitials are force-dynamic because they carry a token).
/** Landing page after /api/access/renew succeeds. */
export default function AccessRenewedPage() {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Renewal requested" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Renewal requested. It is reviewed by hand. If it is approved before your current expiry
        date, access continues without a break; if review is still pending when that date passes,
        downloads are unavailable until it is approved.
      </p>
    </AccessShell>
  );
}
