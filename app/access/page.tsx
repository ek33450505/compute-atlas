import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import { DATASET_ACCESS_TERMS, DATASET_PRIVACY_NOTICE } from "@/lib/dataset-terms";
import { AccessRequestForm } from "./access-request-form";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "./not-open";

// While the flag is off the page is a thin "not open yet" notice, so keep it out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Dataset access",
    description: "Request a personal link to the full Compute Atlas dataset.",
    alternates: { canonical: "/access" },
    ...(isDatasetSharingEnabled() ? {} : { robots: { index: false, follow: false } }),
  };
}

function TermsDetails({ summary, paragraphs }: { summary: string; paragraphs: readonly string[] }) {
  return (
    <details className="rounded-lg border border-input p-4">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm">
        {summary}
      </summary>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p className="text-xs">Terms version {DATASET_TERMS_VERSION}.</p>
        {paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
    </details>
  );
}

// Static: the flag is read at build time; a Vercel env change needs a redeploy (the interstitials are force-dynamic because they carry a token).
/**
 * /access — request a personal link to the full dataset. Static server
 * component; the flag only decides which copy renders, the API route enforces
 * it independently. Interactivity lives in AccessRequestForm.
 */
export default function AccessPage() {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="Dataset access"
        dek={
          <>
            The full Compute Atlas dataset, updated weekly, is free for journalists,
            researchers and organizations whose request is approved. Every request is
            reviewed by hand, usually within a few days.
          </>
        }
      />

      <section aria-labelledby="access-how" className="space-y-3">
        <h2 id="access-how" className="text-lg font-medium">
          How it works
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Each request is reviewed by hand, so the full dataset goes to people who use it, not
          to crawlers or automated scrapers.
        </p>
        <ol className="max-w-2xl list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>Submit the form below.</li>
          <li>Confirm your address from the email. The link is valid for 7 days.</li>
          <li>Once approved, a personal link serves the latest edition for 365 days.</li>
        </ol>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          The data is licensed CC BY 4.0. Credit Compute Atlas when publishing work that uses
          it; see{" "}
          <Link href="/data" className={ACCESS_LINK_CLASS}>
            How to cite
          </Link>
          .
        </p>
      </section>

      <section aria-label="Terms and privacy" className="space-y-3">
        <TermsDetails summary="Access terms" paragraphs={DATASET_ACCESS_TERMS} />
        <TermsDetails summary="Privacy notice" paragraphs={DATASET_PRIVACY_NOTICE} />
      </section>

      <AccessRequestForm termsVersion={DATASET_TERMS_VERSION} />
    </AccessShell>
  );
}
