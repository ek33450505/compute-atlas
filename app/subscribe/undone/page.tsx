import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Email restored",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function SubscribeUndonePage() {
  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Restored"
      title="Automated email is no longer blocked"
      description="We can send automated email to this address again. Subscriptions that were switched off by Stop all automated email stay off: open its unsubscribe link from any earlier email and press Resume, or subscribe again from the site."
      actions={
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Compute Atlas
        </Link>
      }
    />
  );
}
