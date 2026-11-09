import type { Metadata } from "next";

import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { AccessInvalidLink, AccessNotOpen } from "../not-open";

export const metadata: Metadata = {
  title: "Link not valid",
  robots: { index: false, follow: false },
};

// Static: the flag is read at build time; a Vercel env change needs a redeploy (the interstitials are force-dynamic because they carry a token).
/** Landing page when a confirm or renew link is expired, replaced or malformed. */
export default function AccessInvalidPage() {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;
  return <AccessInvalidLink />;
}
