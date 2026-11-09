import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";

export const ACCESS_LINK_CLASS =
  "underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/** The /contact-style page shell shared by every /access page. */
export function AccessShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Dataset access" }]} />
      {children}
    </div>
  );
}

/** What every /access page shows while DATASET_SHARING_ENABLED is off. */
export function AccessNotOpen() {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Dataset access" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Dataset access requests are not open yet. For research or press questions, use the{" "}
        <Link href="/contact" className={ACCESS_LINK_CLASS}>
          contact page
        </Link>
        .
      </p>
    </AccessShell>
  );
}

/** The "link no longer valid" page, also shown by the interstitials for a bad token. */
export function AccessInvalidLink() {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Link not valid" />
      <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>
          This link is no longer valid. Confirmation links expire after 7 days, and a newer
          request for the same address replaces the older link. Renewal links work only until the
          access expiry date.
        </p>
        <p>
          <Link href="/access" className={ACCESS_LINK_CLASS}>
            Submit a new request
          </Link>
        </p>
      </div>
    </AccessShell>
  );
}
