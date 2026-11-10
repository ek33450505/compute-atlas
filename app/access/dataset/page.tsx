import type { Metadata } from "next";
import Link from "next/link";

import { PageMasthead } from "@/components/page-masthead";
import { isCommercialTierEnabled } from "@/lib/commercial-flag";
import { redactedErrorCode } from "@/lib/db-error";
import { DATASET_EDITION_FILES, type DatasetEditionFileName } from "@/lib/dataset-blob";
import { latestPublishedEdition, type PublishedEdition } from "@/lib/dataset-editions";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { getGrantByAccessToken, type DatasetActiveGrant } from "@/lib/dataset-grants";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";
import { ACCESS_LINK_CLASS, AccessNotOpen, AccessShell } from "../not-open";

// The token is in the query and the Cloudflare cache rule caches every non-/admin GET, so this
// response must never be cached. proxy.ts also stamps no-store / noindex / no-referrer headers.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your dataset download",
  robots: { index: false, follow: false },
  // The page's links carry the token to our own origin; never let it travel in a Referer.
  referrer: "no-referrer",
};

const MAX_HEADLINES = 10;

const FILE_DESCRIPTIONS = {
  "facilities.json": "The facility records, one object per facility.",
  "facilities.csv": "The same records as a flat table.",
  "siting-context.json": "Regional siting context keyed by facility id.",
  "changelog.json": "Records added, updated or removed since the previous edition.",
  "README.txt": "Field notes, licence and how to cite.",
} as const satisfies Record<DatasetEditionFileName, string>;

const ATTRIBUTION_LINE = `Data from Compute Atlas by Edward Kubiak (${siteConfig.url}), licensed under CC BY 4.0 (${DATASET_LICENSE_URL}).`;

type ChangelogView = { added?: number; updated?: number; removed?: number; headlines: string[] };

/** `changelog_summary` is stored as jsonb; trust nothing about its shape. */
function narrowChangelog(value: unknown): ChangelogView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
  const headlines = Array.isArray(v.headlines)
    ? v.headlines.filter((h): h is string => typeof h === "string" && h.length > 0).slice(0, MAX_HEADLINES)
    : [];
  const view: ChangelogView = {
    added: count(v.added),
    updated: count(v.updated),
    removed: count(v.removed),
    headlines,
  };
  const hasCounts = view.added !== undefined || view.updated !== undefined || view.removed !== undefined;
  return hasCounts || headlines.length > 0 ? view : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function editionDayLabel(editionDate: string): string {
  const d = new Date(`${editionDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? editionDate : formatDay(d);
}

/** The ONE page shown for every reason a link does not work: same markup, no cause. */
function InactiveLink() {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Link not active" />
      <div className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted-foreground">
        <p>This link isn&apos;t active.</p>
        <p>
          To request access, use the{" "}
          <Link href="/access" className={ACCESS_LINK_CLASS}>
            dataset access page
          </Link>
          . Lost links are reissued by the maintainer on request; ask through the{" "}
          <Link href="/contact" className={ACCESS_LINK_CLASS}>
            contact page
          </Link>
          .
        </p>
      </div>
    </AccessShell>
  );
}

function PreparedFor({ grant }: { grant: DatasetActiveGrant }) {
  return (
    <p className="text-sm text-muted-foreground">
      Prepared for {grant.organization ? `${grant.name}, ${grant.organization}` : grant.name}
    </p>
  );
}

/**
 * "Manage billing" for a paying commercial grant holder. A native form POST so it works without JS;
 * the token travels only in the hidden input (never a URL) to a route that re-checks everything.
 * Renders nothing for free grants, so their page output is unchanged.
 */
function BillingSection({ grant, token }: { grant: DatasetActiveGrant; token: string }) {
  if (grant.tier !== "commercial" || !grant.hasBillingAccount || !isCommercialTierEnabled()) return null;
  return (
    <section aria-labelledby="dl-billing" className="space-y-3">
      <h2 id="dl-billing" className="text-lg font-medium">
        Billing
      </h2>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Change your card, download invoices or cancel your subscription.
      </p>
      <form method="post" action="/api/access/billing-portal">
        <input type="hidden" name="t" value={token} />
        <button
          type="submit"
          className="rounded-sm border border-border px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Manage billing
        </button>
      </form>
    </section>
  );
}

function NoEdition({ grant, token }: { grant: DatasetActiveGrant; token: string }) {
  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title="Your dataset download">
        <PreparedFor grant={grant} />
      </PageMasthead>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        No edition has been published yet. The first edition is built on Saturday; this link will
        work then.
      </p>
      <BillingSection grant={grant} token={token} />
    </AccessShell>
  );
}

function Edition({ grant, edition, token }: { grant: DatasetActiveGrant; edition: PublishedEdition; token: string }) {
  const bytesByName = new Map(edition.files.map((f) => [f.name, f.bytes]));
  const changelog = narrowChangelog(edition.changelogSummary);
  const counts: Array<[string, number]> = [];
  if (changelog) {
    for (const label of ["added", "updated", "removed"] as const) {
      const n = changelog[label];
      if (n !== undefined) counts.push([label, n]);
    }
  }

  return (
    <AccessShell>
      <PageMasthead eyebrow="Data" title={`Edition of ${editionDayLabel(edition.editionDate)}`}>
        <PreparedFor grant={grant} />
        {typeof edition.recordCount === "number" ? (
          <p className="text-sm text-muted-foreground">
            {edition.recordCount.toLocaleString("en-US")} records in this edition.
          </p>
        ) : null}
      </PageMasthead>

      {changelog ? (
        <section aria-labelledby="dl-changes" className="space-y-3">
          <h2 id="dl-changes" className="text-lg font-medium">
            What changed
          </h2>
          {counts.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Since the previous edition: {counts.map(([label, n]) => `${n.toLocaleString("en-US")} ${label}`).join(", ")}.
            </p>
          ) : null}
          {changelog.headlines.length > 0 ? (
            <ul className="max-w-2xl list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
              {changelog.headlines.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="dl-files" className="space-y-3">
        <h2 id="dl-files" className="text-lg font-medium">
          Files
        </h2>
        <ul className="max-w-2xl space-y-3 text-sm leading-relaxed">
          {DATASET_EDITION_FILES.map((name) => {
            const bytes = bytesByName.get(name);
            return (
              <li key={name}>
                <a
                  href={`/api/dataset/file?t=${encodeURIComponent(token)}&f=${name}`}
                  rel="noreferrer"
                  className={`${ACCESS_LINK_CLASS} font-mono`}
                >
                  {name}
                </a>
                {bytes !== undefined && formatBytes(bytes) ? (
                  <span className="text-muted-foreground"> ({formatBytes(bytes)})</span>
                ) : null}
                <p className="text-muted-foreground">{FILE_DESCRIPTIONS[name]}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="dl-terms" className="space-y-3">
        <h2 id="dl-terms" className="text-lg font-medium">
          Licence and your link
        </h2>
        <div className="max-w-2xl space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>{ATTRIBUTION_LINE}</p>
          <p>
            Your link expires on <time dateTime={grant.expiresAt.toISOString()}>{formatDay(grant.expiresAt)}</time>.
          </p>
          <p>
            The files carry recipient-specific identifiers, so each copy is traceable to this link.
            Keep the link private.
          </p>
        </div>
      </section>

      <BillingSection grant={grant} token={token} />
    </AccessShell>
  );
}

/**
 * /access/dataset?t=<token> — a grant holder's personal download page. Server-rendered on every
 * request, no client JS. Every invalid state (no token, malformed, unknown, revoked, expired, a
 * lookup failure) renders the SAME generic page so it cannot be used to probe tokens; the token is
 * never rendered or logged except inside the file hrefs of a live grant.
 */
export default async function AccessDatasetPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  if (!isDatasetSharingEnabled()) return <AccessNotOpen />;

  const { t } = await searchParams;
  if (typeof t !== "string" || t === "") return <InactiveLink />;

  let resolved: Awaited<ReturnType<typeof getGrantByAccessToken>>;
  let edition: PublishedEdition | null = null;
  try {
    resolved = await getGrantByAccessToken(t);
    if (resolved.state === "active") edition = await latestPublishedEdition();
  } catch (err) {
    // SQLSTATE only: a DrizzleQueryError message embeds the bound token hash and params.
    console.error(`dataset download page lookup failed (sqlstate: ${redactedErrorCode(err)})`);
    return <InactiveLink />;
  }

  if (resolved.state !== "active") return <InactiveLink />;
  if (!edition) return <NoEdition grant={resolved.grant} token={t} />;
  return <Edition grant={resolved.grant} edition={edition} token={t} />;
}
