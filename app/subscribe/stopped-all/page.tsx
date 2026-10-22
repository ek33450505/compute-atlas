import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// The URL carries the unsubscribe token (for the Undo button), so it is not
// indexed, sends no Referer, and (reading searchParams) renders dynamically.
export const metadata: Metadata = {
  title: "Automated email stopped",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubscribeStoppedAllPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; state?: string | string[] }>;
}) {
  const { token, state } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";

  // Without a token and without the 'other' marker this page has nothing true
  // to say (only a hand-typed URL gets here), so it is treated as an invalid link.
  if (state !== "other" && !rawToken) {
    redirect("/subscribe/invalid");
  }

  if (state === "other") {
    // All email was already stopped from a different email's link. That
    // link's token is the only one that can undo it, so no Undo button here.
    return (
      <StatePanel
        titleAs="h1"
        eyebrow="Already stopped"
        title="Automated email was already stopped"
        description="Automated email from Compute Atlas to this address was already stopped from another email's link, and only that link can undo it: open the 'Stop all automated email' link in that original email and it will offer Undo. The only exception is a personal reply to a message you send us. If you can't find it, write to us through the contact page."
        actions={
          <div className="flex flex-col items-center gap-3">
            <Link href="/contact" className={buttonVariants({ variant: "default" })}>
              Contact us
            </Link>
            <Link href="/" className={buttonVariants({ variant: "outline" })}>
              Back to Compute Atlas
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Unsubscribed"
      title="Automated email stopped"
      description="You won't receive any more automated email from Compute Atlas at this address: alerts, digests, confirmations and notices. The only exception is a personal reply to a message you send us. Changed your mind? The Undo button lifts the block. You can also open this email's 'Stop all automated email' link again later and it will offer Undo."
      actions={
        <div className="flex flex-col items-center gap-3">
          {rawToken ? (
            <form
              method="post"
              action={`/api/subscribe/unsubscribe?token=${encodeURIComponent(rawToken)}&scope=all&action=undo`}
            >
              <button type="submit" className={buttonVariants({ variant: "outline" })}>
                Undo — start receiving email again
              </button>
            </form>
          ) : null}
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Back to Compute Atlas
          </Link>
        </div>
      }
    />
  );
}
