import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../../not-open";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

// Dynamic so the flag is read per request. Deliberately reads no query string: PayPal's return
// parameters are never used or echoed from here.
export const dynamic = "force-dynamic";

/** Where buyers land after approving the subscription on PayPal. */
export default function CommercialSuccessPage() {
  if (!isCommercialCheckoutOpen()) return <AccessNotOpen />;
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Thank you" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Thanks. When PayPal confirms your subscription, we&apos;ll email your personal download link to
        the address you entered. This usually takes a minute. If it is not in your inbox, check the
        spam folder. If it still has not arrived, use the{" "}
        <Link href="/contact" className={ACCESS_LINK_CLASS}>
          contact page
        </Link>
        .
      </p>
    </AccessShell>
  );
}
