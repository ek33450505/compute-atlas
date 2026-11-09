import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { ACCESS_LINK_CLASS, AccessShell } from "../not-open";

export const metadata: Metadata = {
  title: "Unsubscribed",
  robots: { index: false, follow: false },
};

/**
 * Landing page after /api/dataset/unsubscribe succeeds. The same page follows an unknown token (the route is
 * enumeration-safe), so the copy says what is true of both: the notice mail is off for that link. Ignores
 * DATASET_SHARING_ENABLED like the route: an opt-out confirmation must render after the kill switch is flipped.
 */
export default function AccessUnsubscribedPage() {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Unsubscribed" />
      <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          You are unsubscribed from the weekly dataset edition notice. Your access link is not affected and keeps
          working until its expiry date.
        </p>
        <p>
          To resume the notices, use the{" "}
          <Link href="/contact" className={ACCESS_LINK_CLASS}>
            contact page
          </Link>
          .
        </p>
      </div>
    </AccessShell>
  );
}
