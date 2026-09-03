import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { AccessRequestForm } from "@/components/access/access-request-form";

export const metadata: Metadata = {
  title: "Bulk API access",
  description:
    "Request an email-verified, revocable API access token for a higher, non-anonymous request ceiling — for people building a recurring or automated integration.",
  alternates: { canonical: "/access" },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * /access — requests a double-opt-in bulk API access grant. This is NOT a
 * user account (no password, no login session) — it's an audit-able,
 * revocable access grant, gated only by owning the inbox at the given
 * address. Exists to stop automated scraping/hammering of the API, not to
 * gatekeep the data: anyone who just wants the dataset once can get it with
 * zero login at /data.
 */
export default function AccessPage() {
  return (
    <div
      data-content-width="2xl"
      className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16 space-y-10"
    >
      <Breadcrumb items={[{ label: "Bulk API access" }]} />

      <PageMasthead
        eyebrow="API ACCESS"
        title="Bulk API access"
        dek="An email-verified, revocable access token for a higher request ceiling — no password, no account."
      />

      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
        This exists to stop automated scraping and hammering of the API, not to gatekeep the
        data. The full dataset is still available with zero login at{" "}
        <Link href="/data" className={LINK_CLASS}>
          /data
        </Link>{" "}
        for anyone who just wants it once. This flow is only for people building a recurring
        or automated integration who want a higher, non-anonymous request ceiling.
      </p>

      <p className="max-w-2xl text-sm text-muted-foreground">
        Enter your email and we&rsquo;ll send a confirmation link. Confirming mints a token
        shown to you exactly once &mdash; there is no login, no password, and nothing else is
        stored about you beyond the email address itself.
      </p>

      <AccessRequestForm />
    </div>
  );
}
