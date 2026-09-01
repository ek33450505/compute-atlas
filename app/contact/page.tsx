import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { ContactForm } from "@/components/contact/contact-form";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Reach the maintainer of Compute Atlas for press, research, or partnership inquiries, or a correction to the project or site itself.",
  alternates: { canonical: "/contact" },
};

/**
 * /contact — the public contact channel for press, research, partnership,
 * and corrections to the *project* (not a specific facility record). Static
 * server component; all interactivity lives in ContactForm. Mirrors the
 * masthead structure of /contribute (Breadcrumb -> header -> body), but the
 * dek does the extra work of routing facility tips and record corrections
 * back to /contribute, since both pages otherwise look like "send us
 * something" and would blur together without it.
 */
export default function ContactPage() {
  return (
    <div
      data-content-width="4xl"
      className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12 space-y-10"
    >
      <Breadcrumb items={[{ label: "Explore", href: "/explore" }, { label: "Contact" }]} />

      <PageMasthead
        eyebrow="Contact"
        title="Get in touch"
        dek={
          <>
            For press, research or academic requests, partnerships, or a
            correction to the project or site itself &mdash; not a specific
            facility. Compute Atlas is one person, so replies aren&rsquo;t
            instant, but every message is read.
          </>
        }
      />

      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Have a lead on a facility that isn&rsquo;t on the map, or a
        correction to a specific record &mdash; capacity, status, an
        operator, a source? Those go through review on{" "}
        <Link
          href="/contribute"
          className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          /contribute
        </Link>{" "}
        instead, so a fix is faster and every submission is checked against
        the source before anything is published.
      </p>

      <ContactForm />
    </div>
  );
}
