import type { Metadata } from "next";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { AccessInvalidLink, AccessNotOpen, AccessShell } from "../not-open";

// The token is in the query and the Cloudflare cache rule caches every non-/admin
// GET, so this response must never be cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Renew your access",
  robots: { index: false, follow: false },
};

/**
 * Renew your access interstitial. A mail scanner's prefetch only does a GET, so the action
 * happens on the form POST a person submits. No client JS, no autoFocus.
 */
export default async function AccessRenewPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;

  const { token } = await searchParams;
  if (typeof token !== "string" || !DATASET_TOKEN_RE.test(token)) return <AccessInvalidLink />;

  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Renew your access" />
      <form method="post" action="/api/access/renew" className="max-w-2xl space-y-4">
        <input type="hidden" name="token" value={token} />
        <p className="text-sm leading-relaxed text-muted-foreground">
          Press the button to request a renewal of your dataset access. Renewals are reviewed by
          hand; one approved before your current expiry date continues without a break.
        </p>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Request renewal
        </button>
      </form>
    </AccessShell>
  );
}
