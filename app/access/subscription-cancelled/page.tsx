import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

export const metadata: Metadata = {
  title: "Subscription",
  robots: { index: false, follow: false },
};

type Params = Promise<{ status?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Token-free result page for the subscriber cancel form (`/api/access/subscription/cancel` 303s here).
 * It reads nothing from the database and renders only fixed copy chosen by `status`.
 */
export default async function SubscriptionCancelledPage({ searchParams }: { searchParams: Params }) {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;

  const params = await searchParams;
  const cancelled = first(params.status) === "cancelled";

  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title={cancelled ? "Subscription cancelled" : "Subscription"} />
      {cancelled ? (
        <p role="status" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          Your subscription is cancelled. Your access continues until the end of the period you&apos;ve already
          paid for; the date is shown on your download page.
        </p>
      ) : (
        <p role="alert" className="max-w-2xl rounded-lg border border-input p-4 text-sm">
          We couldn&apos;t cancel right now. Please try again, or cancel in your PayPal account.
        </p>
      )}
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Use the link in your access email to return to your download page. You can also manage automatic
        payments in your{" "}
        <a href="https://www.paypal.com/myaccount/autopay/" rel="noreferrer" className={ACCESS_LINK_CLASS}>
          PayPal account
        </a>
        . Questions? Use the{" "}
        <Link href="/contact" className={ACCESS_LINK_CLASS}>
          contact page
        </Link>
        .
      </p>
    </AccessShell>
  );
}
