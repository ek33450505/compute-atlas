import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { ContributeLeadForm } from "@/components/contribute/contribute-lead-form";
import { ContributeFacilityForm } from "@/components/contribute/contribute-facility-form";
import { SupportCta } from "@/components/support-cta";

export const metadata: Metadata = {
  title: "Share a lead",
  description:
    "Know about a data center, mining site, or power plant that isn't on Compute Atlas yet? Send a link and we'll take it from there — anonymous, source-cited, and checked before anything is published.",
  alternates: { canonical: "/contribute" },
};

/**
 * /contribute — public lead-intake page. Static server component; all
 * interactivity lives in the client components it renders. Lead-first: a
 * bare source link is the whole ask (ContributeLeadForm), with the full
 * facility form (name/operator/coordinates/etc.) tucked behind a closed-by-
 * default <details> disclosure for contributors who already know the
 * details — same disclosure idiom as app/operators/page.tsx's "no disclosed
 * capacity" toggle. Mirrors the masthead structure of /opposition
 * (Breadcrumb -> header -> border-t -> body).
 */
export default function ContributePage() {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Contribute" }]} />

      <PageMasthead
        eyebrow="Contribute"
        title="Share a lead"
        dek={
          <>
            Know about a data center, mining site, or power plant that
            isn&rsquo;t on the map yet? Send the link &mdash; a news article,
            permit filing, or press release &mdash; and we&rsquo;ll take it
            from there. No account needed, and every submission is anonymous.
            If you already know the details, the full form is below.
          </>
        }
      />

      <ContributeLeadForm />

      <details className="group border-t border-border pt-6">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          I know the full details
          <span
            aria-hidden="true"
            className="transition-transform motion-reduce:transition-none group-open:rotate-90"
          >
            →
          </span>
        </summary>
        <div className="mt-6">
          <ContributeFacilityForm />
        </div>
      </details>

      {/* Support the atlas */}
      <section
        aria-labelledby="support-heading"
        className="space-y-4 border-t border-border pt-10"
      >
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Support
        </p>
        <h2 id="support-heading" className="font-display text-2xl text-foreground">
          Support the atlas
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Compute Atlas is free, open, and ad-free. It runs on a small monthly
          infrastructure budget &mdash; a database and hosting &mdash; that I
          cover myself. If it&rsquo;s useful to you, a one-off tip helps keep it
          independent and growing. Either way, every figure stays traceable to a
          public source:{" "}
          <strong className="font-medium text-foreground">
            support never changes what the record says.
          </strong>
        </p>
        <SupportCta />
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          <Link href="/support" className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">
            More on how Compute Atlas is funded
          </Link>{" "}
          &mdash; including what support does not buy.
        </p>
      </section>
    </div>
  );
}
