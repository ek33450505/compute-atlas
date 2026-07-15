import type { Metadata } from "next";

import { Breadcrumb } from "@/components/breadcrumb";
import { ContributeFacilityForm } from "@/components/contribute/contribute-facility-form";

export const metadata: Metadata = {
  title: "Contribute a facility",
  description:
    "Suggest a data center, crypto-mining, or power-generation facility for Compute Atlas. Anonymous, source-cited, and reviewed before publishing.",
};

/**
 * /contribute — public facility-submission form. Static server component;
 * all interactivity (form state, fetch, validation-error surfacing) lives in
 * the client component it renders. Mirrors the masthead structure of
 * /opposition (Breadcrumb -> header -> border-t -> body).
 */
export default function ContributePage() {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Contribute" }]} />

      <header className="space-y-4 pb-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">Contribute</p>
        <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
          Suggest a facility
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          Know a data center, mining site, or power plant that isn&rsquo;t on the
          map yet? Submit it below. No account needed &mdash; every submission
          is anonymous, needs at least one public source, and is reviewed by a
          person before it goes live. We ask for coordinates because the atlas
          is a map first; a rough location beats none.
        </p>
        <div className="border-t border-border" />
      </header>

      <ContributeFacilityForm />
    </div>
  );
}
