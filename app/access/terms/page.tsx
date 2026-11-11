import type { Metadata } from "next";

import { PageMasthead } from "@/components/page-masthead";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import {
  DATASET_ACCESS_TERMS,
  DATASET_COMMERCIAL_TERMS,
  DATASET_PRIVACY_NOTICE,
} from "@/lib/dataset-terms";
import { AccessNotOpen, AccessShell } from "../not-open";

// Same posture as /access: while the flag is off the page is a thin "not open yet" notice, kept out of the index.
export function generateMetadata(): Metadata {
  return {
    title: "Dataset access terms",
    description: "The terms and privacy notice for Compute Atlas dataset access.",
    alternates: { canonical: "/access/terms" },
    ...(isDatasetSharingEnabled() ? {} : { robots: { index: false, follow: false } }),
  };
}

function TermsSection({ heading, paragraphs }: { heading: string; paragraphs: readonly string[] }) {
  return (
    <section aria-labelledby={`terms-${heading}`} className="space-y-3">
      <h2 id={`terms-${heading}`} className="text-lg font-semibold">
        {heading}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        {paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
    </section>
  );
}

/** /access/terms — static text; the terms URL the commercial checkout form links to. */
export default function AccessTermsPage() {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;

  return (
    <AccessShell>
      <PageMasthead
        eyebrow="Data"
        title="Dataset access terms"
        dek={<>Terms version {DATASET_TERMS_VERSION}.</>}
      />
      <TermsSection heading="Access terms" paragraphs={DATASET_ACCESS_TERMS} />
      <TermsSection heading="Commercial subscriptions" paragraphs={DATASET_COMMERCIAL_TERMS} />
      <TermsSection heading="Privacy notice" paragraphs={DATASET_PRIVACY_NOTICE} />
    </AccessShell>
  );
}
