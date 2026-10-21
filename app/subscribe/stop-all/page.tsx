import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { stopAllStateByToken } from "@/lib/subscribe";

// Reached from the "Stop all email" link in our mail. The URL carries the
// unsubscribe token, so it is not indexed and sends no Referer. Nothing
// happens until the button (a POST) is pressed.
export const metadata: Metadata = {
  title: "Stop all automated email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubscribeStopAllPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";

  // Offer the Stop button only while all email is not yet stopped. If it
  // already is, go where the right answer lives (a read, never a write).
  const state = await stopAllStateByToken(rawToken);
  if (state === "stopped_by_this") {
    redirect(`/subscribe/stopped-all?token=${encodeURIComponent(rawToken)}`);
  }
  if (state === "stopped_by_other") {
    redirect("/subscribe/stopped-all?state=other");
  }

  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Stop all automated email"
      title="Stop all automated email from Compute Atlas?"
      description="This ends every watch and digest subscription for your address and stops all automated email from Compute Atlas to it: alerts, digests, confirmations and notices. The only exception is a personal reply to a message you send us."
      actions={
        <div className="flex flex-col items-center gap-3">
          {rawToken ? (
            <form
              method="post"
              action={`/api/subscribe/unsubscribe?token=${encodeURIComponent(rawToken)}&scope=all`}
            >
              <button type="submit" className={buttonVariants({ variant: "default" })}>
                Stop all automated email
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
