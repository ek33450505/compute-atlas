import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// Transactional page reached only via an emailed unsubscribe link — never a
// useful search result, even if the link leaks.
export const metadata: Metadata = {
  title: "Unsubscribed",
  robots: { index: false, follow: false },
};

export default function SubscribeUnsubscribedPage() {
  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Unsubscribed"
      title="Unsubscribed"
      description="You won't receive further alerts for that subscription."
      actions={
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Compute Atlas
        </Link>
      }
    />
  );
}
