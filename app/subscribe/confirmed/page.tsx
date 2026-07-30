import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// Transactional page reached only via an emailed confirm link — never a
// useful search result, even if the link leaks.
export const metadata: Metadata = {
  title: "Subscription confirmed",
  robots: { index: false, follow: false },
};

export default function SubscribeConfirmedPage() {
  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Confirmed"
      title="Subscription confirmed"
      description="You'll get an email when this record changes. Every alert has a one-click unsubscribe."
      actions={
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Compute Atlas
        </Link>
      }
    />
  );
}
