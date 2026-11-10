import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isCommercialCheckoutOpen } from "@/lib/commercial-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../../not-open";

export const metadata: Metadata = {
  title: "Payment received",
  robots: { index: false, follow: false },
};

// Dynamic so the flag is read per request. Deliberately reads no query string: Stripe appends
// nothing we use, and a session id must never be echoed or logged from here.
export const dynamic = "force-dynamic";

/** Where Stripe Checkout returns after payment. */
export default function CommercialSuccessPage() {
  if (!isCommercialCheckoutOpen()) return <AccessNotOpen />;
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Payment received" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Payment received. Your personal download link arrives by email within a few minutes. If it
        is not in your inbox, check the spam folder. If it still has not arrived, use the{" "}
        <Link href="/contact" className={ACCESS_LINK_CLASS}>
          contact page
        </Link>
        .
      </p>
    </AccessShell>
  );
}
