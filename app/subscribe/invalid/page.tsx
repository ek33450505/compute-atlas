import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// Transactional page reached only via a stale/reused confirm or unsubscribe
// link — never a useful search result, even if the link leaks.
export const metadata: Metadata = {
  title: "Link expired or invalid",
  robots: { index: false, follow: false },
};

export default function SubscribeInvalidPage() {
  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Invalid link"
      title="Link expired or invalid"
      description="This confirmation or unsubscribe link has already been used, or the link itself is no longer valid."
      actions={
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Back to Compute Atlas
        </Link>
      }
    />
  );
}
