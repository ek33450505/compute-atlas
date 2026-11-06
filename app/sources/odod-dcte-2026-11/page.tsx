import type { Metadata } from "next";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { breadcrumbJsonLdString } from "@/lib/seo";
import { DCTE_PROVENANCE, DCTE_ROWS } from "@/lib/sources/odod-dcte-2026-11";

export const revalidate = 86400;

const PATH = "/sources/odod-dcte-2026-11";
const TITLE = "Ohio data center tax exemptions: public records response (Nov 2026)";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "The Ohio Department of Development's list of approved data center sales and use tax exemptions (ORC 122.175), released under the Public Records Act in November 2026, with the original spreadsheet.",
  alternates: { canonical: PATH },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

const SECTION_CLASS = "space-y-4 border-t border-border pt-10";
const EYEBROW_CLASS =
  "font-mono text-[10px] uppercase tracking-widest text-muted-foreground";
const BODY_CLASS = "max-w-2xl text-base leading-relaxed text-muted-foreground";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US");

const MONTH_DAY_YEAR = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

function longDate(iso: string): string {
  return MONTH_DAY_YEAR.format(new Date(`${iso}T00:00:00Z`));
}

const COLUMNS = [
  "Beneficiary",
  "City",
  "County",
  "Address",
  "Term (years)",
  "Rate",
  "Jobs created",
  "Created payroll",
  "Jobs retained",
  "Retained payroll",
  "Committed investment",
  "Estimated award",
  "Approved",
] as const;

/**
 * /sources/odod-dcte-2026-11 — a hosted source document: the Ohio Department
 * of Development's list of approved data center sales and use tax exemptions,
 * byte for byte, with its rows rendered readably and one stable `#row-N`
 * anchor per row so a facility record can cite a single line.
 *
 * Loads no database data; revalidates on the 86400s timer only.
 */
export default function OdodDcteSourcePage() {
  const p = DCTE_PROVENANCE;
  const kb = Math.round(p.byteSize / 1024);

  return (
    <div
      data-content-width="3xl"
      className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-10"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbJsonLdString([
            { name: "Home", url: "/" },
            { name: "Source: Ohio data center tax exemptions", url: PATH },
          ]),
        }}
      />

      <Breadcrumb items={[{ label: "Source: Ohio data center tax exemptions" }]} />

      <PageMasthead
        eyebrow="SOURCE DOCUMENT"
        title="Ohio data center tax exemptions: public records response"
        dek="A list of approved data center sales and use tax exemptions, as released by the Ohio Department of Development in November 2026."
      />

      <section aria-labelledby="what-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ What this document is</p>
        <h2 id="what-heading" className="font-display text-2xl text-foreground">
          What this document is
        </h2>
        <p className={BODY_CLASS}>
          A spreadsheet listing {DCTE_ROWS.length} projects approved for the data
          center sales and use tax exemption under {p.statute}. It is the
          department&rsquo;s document, hosted here unaltered so that facility
          records can cite a stable copy. The table below renders its rows; the
          original file is linked under Download.
        </p>
        <p className={BODY_CLASS}>
          The export&rsquo;s last two lines read &ldquo;Confidential Information - Do
          Not Distribute&rdquo; and a salesforce.com copyright notice. The department
          released the file in response to a public records request.
        </p>
      </section>

      <section aria-labelledby="provenance-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ Provenance</p>
        <h2 id="provenance-heading" className="font-display text-2xl text-foreground">
          Provenance
        </h2>
        <dl className="max-w-2xl space-y-3 text-base leading-relaxed text-muted-foreground">
          <div>
            <dt className="font-medium text-foreground">Requested</dt>
            <dd className="space-y-2">
              <span className="block">
                Request submitted {p.requested}{" "}
                by Compute Atlas to the Ohio
                Department of Development under Ohio&rsquo;s Public Records Act (
                {p.requestStatute}). The request asked for:
              </span>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  all executed {p.statute} data center sales and use tax exemption
                  agreements, including exhibits and scope-of-work documents;
                </li>
                <li>
                  any list or spreadsheet of approved {p.statute} projects, with
                  company name, project location and approval date;
                </li>
                <li>
                  Tax Credit Authority meeting minutes for 2024&ndash;2026 that
                  approve {p.statute} exemptions.
                </li>
              </ol>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Received</dt>
            <dd>
              {p.received}. The department described this file as &ldquo;a list of
              approved data center exemptions&rdquo;.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Statute</dt>
            <dd>
              {p.statute} (data center sales and use tax exemption); records
              requested under {p.requestStatute}.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Released by</dt>
            <dd>Ohio Department of Development</dd>
          </div>
        </dl>
        <p className={BODY_CLASS}>
          The agreements themselves were provided separately, with portions
          redacted under {p.requestStatute}(A)(1)(dd), and are not hosted here. The
          department&rsquo;s reply pointed to its Tax Credit Authority page for
          meeting minutes:{" "}
          <a
            href="https://development.ohio.gov/about-us/boards-and-commissions/ohio-tax-credit-authority"
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            development.ohio.gov/about-us/boards-and-commissions/ohio-tax-credit-authority
          </a>
        </p>
      </section>

      <section aria-labelledby="columns-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ How to read the columns</p>
        <h2 id="columns-heading" className="font-display text-2xl text-foreground">
          How to read the columns
        </h2>
        <ul className="max-w-2xl list-disc space-y-2 pl-5 text-base leading-relaxed text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">Estimated award:</span>{" "}
            the sheet labels it an estimate (&ldquo;Estimated Award Amount&rdquo;).
          </li>
          <li>
            <span className="font-medium text-foreground">Rate and term:</span>{" "}
            as the sheet gives them. The Tax Credit Authority&rsquo;s minutes
            describe these awards as a percentage for a number of years; the{" "}
            <a
              href="https://dam.assets.ohio.gov/image/upload/development.ohio.gov/about/taxcreditminutes/June_24_2024.pdf"
              target="_blank"
              rel="noreferrer noopener"
              className={LINK_CLASS}
            >
              June 24, 2024 minutes
            </a>
            , for example, approve &ldquo;a tax exemption of 50% for 10 years&rdquo; for
            Vantage Data Centers, so a rate of 0.5 is 50%. Term is shown as written in
            the sheet, such as &ldquo;15 (up to 40)&rdquo;.
          </li>
        </ul>
        <p className={BODY_CLASS}>
          The sheet&rsquo;s own Total row gives estimated awards of{" "}
          {usd.format(
            DCTE_ROWS.reduce((sum, r) => sum + r.estimatedAward, 0),
          )}{" "}
          across {DCTE_ROWS.length}{" "}
          projects. The Amazon row lists &ldquo;Twenty five
          sites in Ohio&rdquo; in place of a city and address, with no county; it is
          shown as released.
        </p>
      </section>

      <section aria-labelledby="download-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ Download</p>
        <h2 id="download-heading" className="font-display text-2xl text-foreground">
          Download
        </h2>
        <p className={BODY_CLASS}>
          <a href={p.filePath} download className={LINK_CLASS}>
            Download the spreadsheet (.xlsx, {kb} KB)
          </a>
          . File name: <span className="font-mono text-sm">odod-dcte-2026-11.xlsx</span>
          , {integer.format(p.byteSize)} bytes.
        </p>
        <p className={BODY_CLASS}>
          The SHA-256 below is that of the file as received; the hosted copy carries
          the same hash.
        </p>
        <p className="max-w-full break-all font-mono text-sm text-muted-foreground">
          SHA-256: <span>{p.sha256}</span>
        </p>
      </section>

      <section aria-labelledby="table-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ The table</p>
        <h2 id="table-heading" className="font-display text-2xl text-foreground">
          The table
        </h2>
        <p id="table-scroll-hint" className="text-sm text-muted-foreground">
          The table scrolls horizontally on narrow screens. Each beneficiary name
          links to its own row.
        </p>
        <div
          role="region"
          aria-label="Approved data center tax exemptions table"
          aria-describedby="table-scroll-hint"
          tabIndex={0}
          className="overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <table className="w-full min-w-[72rem] border-collapse text-left text-sm">
            <caption className="pb-3 text-left text-sm text-muted-foreground">
              Approved data center sales and use tax exemptions, in the order of the
              released spreadsheet. Amounts in US dollars.
            </caption>
            <thead>
              <tr className="border-b border-border">
                {COLUMNS.map((c) => (
                  <th
                    key={c}
                    scope="col"
                    className="px-2 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DCTE_ROWS.map((r) => (
                <tr
                  key={r.anchor}
                  id={r.anchor}
                  className="scroll-mt-20 border-b border-border align-top target:bg-muted target:outline target:outline-2 target:-outline-offset-2 target:outline-ring"
                >
                  <th scope="row" className="px-2 py-2 font-medium text-foreground">
                    <a href={`#${r.anchor}`} className={LINK_CLASS}>
                      {r.beneficiary}
                    </a>
                  </th>
                  <td className="px-2 py-2">{r.city}</td>
                  <td className="px-2 py-2">{r.county}</td>
                  <td className="px-2 py-2">{r.address}</td>
                  <td className="px-2 py-2">{r.termYears}</td>
                  <td className="px-2 py-2">{percent.format(r.rate)}</td>
                  <td className="px-2 py-2">{integer.format(r.jobsCreated)}</td>
                  <td className="px-2 py-2">{usd.format(r.jobsCreatedPayroll)}</td>
                  <td className="px-2 py-2">{integer.format(r.jobsRetained)}</td>
                  <td className="px-2 py-2">{usd.format(r.jobsRetainedPayroll)}</td>
                  <td className="px-2 py-2">{usd.format(r.committedInvestment)}</td>
                  <td className="px-2 py-2">{usd.format(r.estimatedAward)}</td>
                  <td className="px-2 py-2">
                    <time dateTime={r.approvalDate}>{longDate(r.approvalDate)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
