import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { isTokenRowUnsubscribed } from "@/lib/subscribe";

// Reached from the unsubscribe link in our mail. The URL carries the
// unsubscribe token, so it is not indexed, sends no Referer, and (reading
// searchParams) renders dynamically. Nothing happens until the button, a
// POST, is pressed: mail scanners prefetch links, and opt-outs are durable.
export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubscribeUnsubscribeConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";

  // Already unsubscribed (e.g. a scanner or a second click got there first, or
  // the person wants to come back): offer Resume instead. A read; the buttons
  // are POST forms.
  if (rawToken && (await isTokenRowUnsubscribed(rawToken))) {
    return (
      <StatePanel
        titleAs="h1"
        eyebrow="Unsubscribed"
        title="Already unsubscribed"
        description="You're unsubscribed from this subscription. Changed your mind? Resume it below."
        actions={
          <div className="flex flex-col items-center gap-3">
            <form
              method="post"
              action={`/api/subscribe/unsubscribe?token=${encodeURIComponent(rawToken)}&action=resume`}
            >
              <button type="submit" className={buttonVariants({ variant: "default" })}>
                Resume this subscription
              </button>
            </form>
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
      eyebrow="Unsubscribe"
      title="Unsubscribe from this subscription?"
      description="You'll stop receiving alerts for the subscription in the email you clicked from. Your other subscriptions are not affected."
      actions={
        <div className="flex flex-col items-center gap-3">
          {rawToken ? (
            <form method="post" action={`/api/subscribe/unsubscribe?token=${encodeURIComponent(rawToken)}`}>
              <button type="submit" className={buttonVariants({ variant: "default" })}>
                Unsubscribe
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
