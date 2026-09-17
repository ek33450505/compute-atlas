import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { SupportCta } from "@/components/support-cta";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Compute Atlas is free to read, open source, and carries no advertising. If it's useful to you, a one-off tip or a sponsorship helps cover the database, hosting, and discovery pipeline that keep it running — without changing what the record says.",
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
 * GitHub fee percentage, no facility count, and NO DOLLAR FIGURE.
 *
 * Named cost CATEGORIES and suppliers are permitted (added 2026-09-14, Ed's
 * call) — a database, hosting, and the discovery pipeline's model
 * subscription. A dollar amount is still barred, and deliberately: a monthly
 * bill is the fastest-rotting number on the site, nothing here re-checks it,
 * and the project's own claims discipline prefers countable-and-stable over
 * impressive-and-rotting.
 *
 * ⛔ "It has never published a record." must survive any edit to the discovery
 * sentence. Disclosing an AI cost invites the reading that the DATASET is
 * AI-generated, which is the most damaging conclusion a reader could draw and
 * is false — every candidate is staged for human approval (see the core
 * invariant in CLAUDE.md). Delete the whole discovery line before shipping it
 * without that clause.
 *
 * ⛔ "Where I stand" is the one section on this site that carries an OPINION,
 * and three things make that safe to ship (added 2026-09-16, Ed's call):
 *   1. It sits AFTER "What support does not change", never before. The reader
 *      meets the neutrality guarantee first and the opinion second; reversed,
 *      the guarantee reads as a walk-back of the opinion instead of the frame
 *      around it.
 *   2. It disowns itself in the dataset's voice — "That is my opinion. It is
 *      not this dataset's." — and routes disagreement to /contribute and the
 *      public change log. That sentence is load-bearing: the project's whole
 *      asset is a record nobody can accuse of arguing, and an unhedged
 *      position here would put that in play to win nothing.
 *   3. It cites NO figure. The moment a number appears in this section it
 *      stops being a stated view and becomes an uncited claim on a site whose
 *      entire premise is that claims carry sources.
 * Keep all three or drop the section.
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
            advertising. It runs on a small monthly budget I cover myself: a
            managed Postgres database, hosting, and the AI subscription behind
            the discovery pipeline. If the atlas is useful to you, there are
            two ways to help pay for it, and several that cost nothing.
          </>
        }
      />

      {/* Why it exists */}
      <section aria-labelledby="why-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Why it exists
        </p>
        <h2 id="why-heading" className="font-display text-2xl text-foreground">
          Why I built this
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Counties, townships and cities are each meeting the datacenter
          buildout alone. A board sits down with a rezoning application and no
          practical way to know that the same operator filed three counties
          over, what the water commitment looked like when it went through, or
          what the abatement actually returned. The applicant has been to a
          hundred of these meetings. The board has been to one.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          That asymmetry isn&rsquo;t a secrecy problem &mdash; nearly all of it
          is public. It&rsquo;s a collection problem. The filings exist, but
          they sit in permit dockets, rate cases, interconnection queues and
          county board agendas, in a shape nobody without a research budget can
          hold all at once. Scattered, the record is technically open and
          practically useless.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Put it in one place and people start finding each other in it. A
          resident sees their objection isn&rsquo;t unique. A reporter sees the
          pattern across a state instead of one hearing. An official sees what
          the board next door negotiated before signing the same terms.
          Individually these are twelve separate local fights; side by side
          they are one buildout, and a community can meet it as a bloc &mdash;
          resolving it or fighting it &mdash; instead of one agenda item at a
          time.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          I have the skill set for that particular job. I decided to point it
          at something that mattered.
        </p>
      </section>

      {/* Who's behind it */}
      <section aria-labelledby="maintainer-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Who&rsquo;s behind it
        </p>
        <h2 id="maintainer-heading" className="font-display text-2xl text-foreground">
          Who&rsquo;s behind it
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          I&rsquo;m{" "}
          <a
            href="https://edwardkubiak.com"
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            Edward Kubiak <span aria-hidden="true">↗</span>
          </a>
          , a full-stack developer and AI systems engineer in Columbus, Ohio.
          There is no company behind Compute Atlas, no investor, and no outside
          funding. It is one person, and this page is the whole business model.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Agents write most of my code now. That moved the work rather than
          removing it &mdash; the judgment, the verification and the
          consequences all stayed exactly where they were &mdash; and most of
          what I build these days is the tooling that keeps that honest. I
          spend my review time on the failures that look like successes, and
          I&rsquo;ve written up the loop I actually run, including the times
          the output looked right and wasn&rsquo;t.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          That habit is the reason this site is built the way it is. Every
          figure cites a source you can open. Every correction lands in a
          public change log. The discovery pipeline reads public filings
          overnight and has never once published a record &mdash; it proposes,
          and a person accepts or rejects each candidate by hand. Cheap to
          automate, expensive to be wrong: the review stays human where being
          wrong is costly.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          I gravitate toward work that values craft, ships iteratively and
          never stops learning. The best software comes out of understanding
          the people who depend on it, not just the stack underneath it. This
          project is what that looks like when nobody is paying for it.
        </p>
      </section>

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
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Three things cost money every month. The database is the largest
          &mdash; a managed Postgres instance (Neon) holding every facility,
          every citation, and the full revision history behind the change log;
          almost all of that is data moving between the database and the site
          rather than data stored, because the dataset itself is only tens of
          megabytes. Hosting (Vercel) serves every facility page, the
          full-screen map, and an open JSON API, with no paywall and no paid
          tier. The third is the discovery pipeline, which runs on a paid
          Claude subscription: it reads public sources overnight and proposes
          candidates. It has never published a record. Every candidate is
          staged for a person to approve or reject by hand &mdash; so what
          that line item buys is the search, not the writing.
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

      {/* Where I stand — the one opinion on the site, fenced off on purpose */}
      <section aria-labelledby="stand-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Where I stand
        </p>
        <h2 id="stand-heading" className="font-display text-2xl text-foreground">
          Where I stand
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          One thing left, kept deliberately separate from everything above.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          I don&rsquo;t think this buildout is proportionate. The compute going
          up right now runs well ahead of anything I can see in what people
          actually use, and it is being built at a speed that forecloses the
          smaller, denser, cleaner version that was available. The other half
          of the ledger is barely being read at all &mdash; least of all the
          new gas generation being permitted to feed it, which is the part
          that will still be burning long after this particular capacity race
          has been won by somebody.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          That is my opinion. It is not this dataset&rsquo;s.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The record takes no position, and it would be worth far less if it
          did &mdash; to me most of all, because the argument worth having is
          the one where everyone is working from the same numbers. A map that
          argues gets dismissed by exactly the people who most need to read it.
          So if you ever find a place where my view has bent a figure, that is
          a bug, not an editorial line:{" "}
          <Link href="/contribute" className={LINK_CLASS}>
            send me a correction
          </Link>{" "}
          and it will surface in the{" "}
          <Link href="/activity" className={LINK_CLASS}>
            public change log
          </Link>{" "}
          with the old value still visible next to the new one.
        </p>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Fight the power. Respectfully, and with citations.
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
