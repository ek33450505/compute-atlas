import Link from "next/link";
import type { Metadata } from "next";

import { GLOSSARY_TOPICS } from "@/lib/glossary";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { breadcrumbJsonLdString, itemListJsonLdString } from "@/lib/seo";
import { siteConfig } from "@/lib/site";

export const revalidate = 3600;

const CRUMBS = [{ label: "Explore", href: "/explore" }, { label: "Learn" }];

export const metadata: Metadata = {
  title: "Data center glossary",
  description:
    "Plain-language answers to common data center questions — water use, power draw, AI classification, on-site generation, and community opposition — grounded in Compute Atlas's tracked dataset.",
  alternates: { canonical: "/learn" },
};

/**
 * /learn — index of the glossary/explainer hub. Static server component.
 *
 * Lists every topic in GLOSSARY_TOPICS, each linking to its own
 * /learn/[topic] explainer page. Mirrors the /states index's list pattern
 * (masthead + block-Link list); each row shows the topic's title + dek since
 * there's no per-topic summary figure worth surfacing inline here — that
 * lives on the topic page itself.
 */
export default function LearnIndexPage() {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString(
            CRUMBS.map((c) => ({ name: c.label, url: c.href }))
          ),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: itemListJsonLdString(
            GLOSSARY_TOPICS.map(({ title, slug }) => ({
              name: title,
              url: `${siteConfig.url}/learn/${slug}`,
            }))
          ),
        }}
      />

      <Breadcrumb items={CRUMBS} />

      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                            */}
      {/* ------------------------------------------------------------------ */}
      <PageMasthead
        eyebrow="Learn"
        title="Data center glossary"
        dek="Plain-language answers to the questions that come up most, each grounded in the facilities Compute Atlas tracks."
      >
        <p className="text-base text-muted-foreground">
          {GLOSSARY_TOPICS.length} topics
        </p>
      </PageMasthead>

      {/* ------------------------------------------------------------------ */}
      {/* Topic list                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="topics-list-heading" className="space-y-4">
        <h2 id="topics-list-heading" className="sr-only">
          All glossary topics
        </h2>
        <ul className="space-y-2">
          {GLOSSARY_TOPICS.map(({ slug, title, dek }) => (
            <li key={slug}>
              <Link
                href={`/learn/${slug}`}
                className="flex min-h-11 flex-col gap-1 rounded-sm border border-border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <span className="text-sm text-foreground">{title}</span>
                <span className="text-xs text-muted-foreground">{dek}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
