import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

// Reached from the confirm link in our mail (via /api/subscribe/confirm). The
// URL carries the confirm token, so it is not indexed, sends no Referer, and
// (reading searchParams) renders dynamically. Nothing happens until the
// button, a POST, is pressed: mail scanners prefetch links.
export const metadata: Metadata = {
  title: "Confirm your watch",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubscribeConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  const rawToken = typeof token === "string" ? token : "";
  if (!rawToken) {
    redirect("/subscribe/invalid");
  }

  return (
    <StatePanel
      titleAs="h1"
      eyebrow="Confirm"
      title="Confirm your watch"
      description="Confirming means you'll get email when the watched record or area changes. You can unsubscribe from any email."
      actions={
        <div className="flex flex-col items-center gap-3">
          <form method="post" action={`/api/subscribe/confirm?token=${encodeURIComponent(rawToken)}`}>
            <button type="submit" className={buttonVariants({ variant: "default" })}>
              Confirm
            </button>
          </form>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Not now
          </Link>
        </div>
      }
    />
  );
}
