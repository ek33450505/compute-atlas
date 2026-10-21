import Link from "next/link";
import type { Metadata } from "next";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// Transactional page reached only via an emailed unsubscribe link — never a
// useful search result, even if the link leaks. The URL carries the
// unsubscribe token (for the two buttons below), so it sends no Referer.
export const metadata: Metadata = {
  title: "Unsubscribed",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubscribeUnsubscribedPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";
  const encoded = encodeURIComponent(rawToken);

  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Unsubscribed"
      title="Unsubscribed"
      description="You won't receive further alerts for that subscription."
      actions={
        <div className="flex flex-col items-center gap-3">
          {rawToken ? (
            <>
              {/* Both are POST forms: a mail scanner following links cannot trigger them. A button
                  click is itself the confirmation, so unlike the emailed (GET) link there is
                  no interstitial before stop-all here. */}
              <form method="post" action={`/api/subscribe/unsubscribe?token=${encoded}&scope=all`}>
                <button type="submit" className={buttonVariants({ variant: "outline" })}>
                  Stop all automated email
                </button>
              </form>
              <form method="post" action={`/api/subscribe/unsubscribe?token=${encoded}&action=resume`}>
                <button type="submit" className={buttonVariants({ variant: "outline" })}>
                  Resume this subscription
                </button>
              </form>
            </>
          ) : null}
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Back to Compute Atlas
          </Link>
        </div>
      }
    />
  );
}
