import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { ACCESS_LINK_CLASS, AccessShell } from "../not-open";

// The token is in the query and the Cloudflare cache rule caches every non-/admin
// GET, so this response must never be cached.
export const dynamic = "force-dynamic";

// The URL carries the unsubscribe token: not indexed, and no Referer to outbound links.
export const metadata: Metadata = {
  title: "Unsubscribe from edition notices",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Unsubscribe-specific invalid copy: the generic one talks about confirmation and renewal links. */
function UnsubscribeInvalidLink() {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Link not valid" />
      <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          This unsubscribe link isn&apos;t valid. To stop dataset edition notices, use the link in your most recent
          notice email, or{" "}
          <Link href="/contact" className={ACCESS_LINK_CLASS}>
            contact us
          </Link>
          .
        </p>
      </div>
    </AccessShell>
  );
}

/**
 * Unsubscribe interstitial, the target of `GET /api/dataset/unsubscribe`. A mail scanner's prefetch only does a
 * GET, so the opt-out happens on the form POST a person submits. No client JS, no autoFocus. A page that does
 * a lookup would be an oracle for token validity, so a well-formed token always gets the form. Like the route,
 * it ignores DATASET_SHARING_ENABLED: an opt-out must keep working after the kill switch is flipped.
 */
export default async function AccessUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  if (typeof token !== "string" || !DATASET_TOKEN_RE.test(token)) return <UnsubscribeInvalidLink />;

  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Unsubscribe from edition notices" />
      <form
        method="post"
        action={`/api/dataset/unsubscribe?token=${encodeURIComponent(token)}`}
        className="max-w-2xl space-y-4"
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          Press the button to stop the weekly email about each new dataset edition. Your access link keeps working.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          If you do not want to unsubscribe, close this page and nothing happens.
        </p>
        <button
          type="submit"
          className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Unsubscribe from edition notices
        </button>
      </form>
    </AccessShell>
  );
}
