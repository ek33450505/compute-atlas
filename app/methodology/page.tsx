import type { Metadata } from "next";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { MethodologyMarkdown } from "@/components/methodology-markdown";
import { METHODOLOGY_BODY_MARKDOWN } from "@/lib/methodology";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How Compute Atlas finds facilities, the sourcing standard every record is held to, and how to read the citations behind a record — the reference doc, published in full.",
  alternates: { canonical: "/methodology" },
};

/**
 * /methodology — renders `docs/methodology.md` itself (via
 * lib/methodology.ts + components/methodology-markdown.tsx), not a hand-port
 * of its prose. The maintainer chose this specifically so the page can never
 * drift from the doc: one source of truth, read at build time (see
 * lib/methodology.ts for why that's safe on Vercel's serverless runtime).
 *
 * No `revalidate` export: the doc changes only on a code deploy, so this
 * page is fully static, matching /support and /contribute (also
 * revalidate-less, STATIC_PAGE_LAST_MODIFIED in app/sitemap.ts).
 */
export default function MethodologyPage() {
  return (
    <div
      data-content-width="3xl"
      className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-10"
    >
      <Breadcrumb items={[{ label: "About", href: "/about" }, { label: "Methodology" }]} />

      <PageMasthead
        eyebrow="Methodology"
        title="Methodology"
        dek="How facilities are found, the sourcing standard every record is held to, and how to read the citations behind a record — published in full, not summarized."
      />

      <MethodologyMarkdown source={METHODOLOGY_BODY_MARKDOWN} />
    </div>
  );
}
