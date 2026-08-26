import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SupportCta } from "@/components/support-cta";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Compute Atlas is free to read, open source, and carries no advertising. If it's useful to you, a one-off tip or a sponsorship helps cover the database and hosting that keep it running — without changing what the record says.",
  alternates: { canonical: "/support" },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * /support — the canonical funding ask. Static server component; the only
 * interactive elements are the plain anchor tags in <SupportCta /> and below,
 * none of which need client-side state. Mirrors the masthead/section rhythm
 * of app/contribute/page.tsx (Breadcrumb -> PageMasthead -> border-t sections).
 *
 * Claims discipline (audited copy, do not extend): no privacy/tracking claim
 * (Vercel Analytics + Speed Insights are mounted in app/layout.tsx), no Ko-fi/
 * GitHub fee percentage, no facility count or dollar figure.
 */
export default function SupportPage() {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "About", href: "/about" }, { label: "Support" }]} />

      <PageMasthead
        eyebrow="Support"
        title="Support the atlas"
        dek={
          <>
            Compute Atlas is free to read, open source, and carries no
            advertising. It runs on a small monthly infrastructure budget
            &mdash; a database and hosting &mdash; that I cover myself. If the
            atlas is useful to you, there are two ways to help pay for it, and
            several that cost nothing.
          </>
        }
      />

      {/* Where support goes */}
      <section aria-labelledby="where-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Where it goes
        </p>
        <h2 id="where-heading" className="font-display text-2xl text-foreground">
          Where support goes
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Every facility on this map exists because someone read a permit
          filing, a rate case, an interconnection queue, or a county board
          agenda and wrote down what it said. Support doesn&rsquo;t buy that
          part back. It covers the part underneath: a database that stays
          awake, hosting that serves every facility page and a full-screen map
          without a paywall, and the geospatial data the map draws on.
        </p>
        <SupportCta />
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Ko-fi takes one-off tips without an account &mdash; guest checkout,
          card or PayPal. GitHub Sponsors is the other path; it needs a GitHub
          account, which is why it sits second here.
        </p>
      </section>

      {/* What support does not change */}
      <section aria-labelledby="guarantee-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § The guarantee
        </p>
        <h2 id="guarantee-heading" className="font-display text-2xl text-foreground">
          What support does not change
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Nothing on this site is for sale. A tip or a sponsorship does not
          buy a record, an edit, a removal, or a place in a ranking &mdash;
          there is no tier that does, and there won&rsquo;t be. No page
          carries advertising.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          That is a promise, so here is what makes it checkable rather than
          something you have to take on trust: every figure cites a public
          source, the dataset is published under CC-BY-4.0 and the code under
          MIT, and every correction is recorded in the public{" "}
          <Link href="/activity" className={LINK_CLASS}>
            change log
          </Link>
          . If a record ever moved for a reason that isn&rsquo;t in a
          citation, the history would show it. For how the data itself is
          gathered and checked, see{" "}
          <Link href="/about" className={LINK_CLASS}>
            about &amp; method
          </Link>
          .
        </p>
      </section>

      {/* Ways to help that cost nothing */}
      <section aria-labelledby="free-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Free ways
        </p>
        <h2 id="free-heading" className="font-display text-2xl text-foreground">
          Ways to help that cost nothing
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Most of what improves the atlas isn&rsquo;t money.
        </p>
        <ul className="max-w-2xl list-disc list-inside space-y-2 text-sm text-muted-foreground">
          <li>
            <strong className="font-medium text-foreground">Send a lead.</strong>{" "}
            A single link &mdash; a news article, a permit filing, a press
            release &mdash; is the whole ask.{" "}
            <Link href="/contribute" className={LINK_CLASS}>
              Share a lead
            </Link>
            .
          </li>
          <li>
            <strong className="font-medium text-foreground">Send a correction.</strong>{" "}
            If a record is wrong, say so. A wrong figure is worse than a
            missing one: downstream it is indistinguishable from a verified
            fact.{" "}
            <Link href="/contribute" className={LINK_CLASS}>
              Send a correction
            </Link>
            .
          </li>
          <li>
            <strong className="font-medium text-foreground">Use it in public.</strong>{" "}
            Cite it, link it, or{" "}
            <a
              href={siteConfig.repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="View the Compute Atlas repository on GitHub (opens in new tab)"
              className={LINK_CLASS}
            >
              open an issue on the repo <span aria-hidden="true">↗</span>
            </a>
            .
          </li>
        </ul>
      </section>
    </div>
  );
}
