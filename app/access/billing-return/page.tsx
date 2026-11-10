import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

export const metadata: Metadata = {
  title: "Billing",
  robots: { index: false, follow: false },
};

// Dynamic so the flag is read per request. Reads only `status`; it never carries a token.
export const dynamic = "force-dynamic";

/** Where the Stripe billing portal returns, and where the billing-portal route sends every failure. */
export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  if (!isCommercialTierEnabled()) return <AccessNotOpen />;
  const { status } = await searchParams;
  const unavailable = status === "unavailable";
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title={unavailable ? "Billing unavailable" : "Back from billing"} />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {unavailable ? (
          <>
            Billing could not be opened. Use your personal link from your email to try again, or
            contact us through the{" "}
            <Link href="/contact" className={ACCESS_LINK_CLASS}>
              contact page
            </Link>
            .
          </>
        ) : (
          "You're back from billing. Use the personal link from your email to return to your downloads."
        )}
      </p>
    </AccessShell>
  );
}
