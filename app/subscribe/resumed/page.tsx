import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Subscription resumed",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const COPY = {
  resumed: {
    eyebrow: "Resumed",
    title: "Subscription resumed",
    description: "You'll receive alerts for that subscription again.",
  },
  active: {
    eyebrow: "Already active",
    title: "Already subscribed",
    description: "That subscription is already active, so nothing changed.",
  },
  stopped: {
    eyebrow: "Still stopped",
    title: "Automated email is still stopped",
    description:
      "That subscription is back on, but you earlier chose to stop all automated email from Compute Atlas, so no alerts will be sent to this address. To undo that, open the 'Stop all automated email' link in the email you used to stop it; it will offer Undo. If you no longer have that email, write to us through the contact page.",
  },
  retry: {
    eyebrow: "Almost done",
    title: "Please press Resume again",
    description:
      "That subscription is back on, but we couldn't finish lifting the block on alerts. Press Resume again to finish.",
  },
} as const;

export default async function SubscribeResumedPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[]; token?: string | string[] }>;
}) {
  const { state, token } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";
  const copy =
    state === "active"
      ? COPY.active
      : state === "stopped"
        ? COPY.stopped
        : state === "retry"
          ? COPY.retry
          : COPY.resumed;

  return (
    <StatePanel
      titleAs="h1"
      eyebrow={copy.eyebrow}
      title={copy.title}
      description={copy.description}
      actions={
        <div className="flex flex-col items-center gap-3">
          {state === "retry" && rawToken ? (
            <form
              method="post"
              action={`/api/subscribe/unsubscribe?token=${encodeURIComponent(rawToken)}&action=resume`}
            >
              <button type="submit" className={buttonVariants({ variant: "default" })}>
                Resume again
              </button>
            </form>
          ) : null}
          {state === "stopped" ? (
            <Link href="/contact" className={buttonVariants({ variant: "default" })}>
              Contact us
            </Link>
          ) : null}
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Back to Compute Atlas
          </Link>
        </div>
      }
    />
  );
}
