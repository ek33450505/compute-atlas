import type { Metadata } from "next";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { breadcrumbJsonLdString } from "@/lib/seo";
import {
  OTC_1357_PROVENANCE,
  OTC_1357_ROWS,
  type OtcRow,
} from "@/lib/sources/otc-1357-21-2026-11";

export const revalidate = 86400;

const PATH = "/sources/otc-1357-21-2026-11";
const TITLE =
  "Oklahoma computer services sales tax exemptions: public records response (Nov 2026)";

export const metadata: Metadata = {
  title: TITLE,
  description:
    "The Oklahoma Tax Commission's two reports of active computer services sales tax exemption accounts (68 O.S. § 1357(21)), released under the Oklahoma Open Records Act in November 2026, with the original PDFs.",
  alternates: { canonical: PATH },
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

const SECTION_CLASS = "space-y-4 border-t border-border pt-10";
const EYEBROW_CLASS =
  "font-mono text-[10px] uppercase tracking-widest text-muted-foreground";
const BODY_CLASS = "max-w-2xl text-base leading-relaxed text-muted-foreground";

const integer = new Intl.NumberFormat("en-US");

const COLUMNS = [
  "Entity name",
  "DBA name",
  "Mailing address",
  "Location address",
] as const;

function Cell({ value }: { value: string }) {
  if (value !== "") return <>{value}</>;
  return (
    <>
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">blank</span>
    </>
  );
}

function RowHeader({ row }: { row: OtcRow }) {
  return (
    <th scope="row" className="px-2 py-2 font-medium text-foreground">
      <a href={`#${row.anchor}`} className={LINK_CLASS}>
        {row.entityName === "" ? (
          <>
            <span aria-hidden="true">&mdash;</span>
            <span className="sr-only">
              {row.dbaName} (entity name blank on report)
            </span>
          </>
        ) : (
          row.entityName
        )}
      </a>
    </th>
  );
}

/**
 * /sources/otc-1357-21-2026-11 — a hosted source document: the two Oklahoma
 * Tax Commission reports of active computer services sales tax exemption
 * accounts, byte for byte, with their rows rendered readably and one stable
 * `#50-row-N` / `#80-row-N` anchor per row so a facility record can cite a
 * single line.
 *
 * Loads no database data; revalidates on the 86400s timer only.
 */
export default function OtcSourcePage() {
  const p = OTC_1357_PROVENANCE;

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
            { name: "Source: Oklahoma computer services sales tax exemptions", url: PATH },
          ]),
        }}
      />

      <Breadcrumb items={[{ label: "Source: Oklahoma computer services sales tax exemptions" }]} />

      <PageMasthead
        eyebrow="SOURCE DOCUMENT"
        title="Oklahoma computer services sales tax exemptions: public records response"
        dek="Two reports of active exemption accounts, as released by the Oklahoma Tax Commission in November 2026."
      />

      <section aria-labelledby="what-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ What this document is</p>
        <h2 id="what-heading" className="font-display text-2xl text-foreground">
          What this document is
        </h2>
        <p className={BODY_CLASS}>
          Two PDF reports from the Oklahoma Tax Commission, titled &ldquo;
          {p.files[0].title}&rdquo; and &ldquo;{p.files[1].title}&rdquo;. They are
          the Commission&rsquo;s documents, hosted here unaltered so that facility
          records can cite a stable copy. The tables below render their rows; the
          original files are linked under Download.
        </p>
        <p className={BODY_CLASS}>
          The reports do not print a statute number. The request named{" "}
          {p.statute}, and the received file names begin &ldquo;1357 21&rdquo;. The
          reports are titled &ldquo;Active Computer Services (50%) Exemptions&rdquo;
          and &ldquo;Active Computer Services (80%) Exemptions&rdquo;. Each is
          stamped &ldquo;Report Generated:&rdquo; with a date and time and prints
          &ldquo;Total Active Accounts:&rdquo; with a number. Neither shows an
          amount or date column.
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
                to the Oklahoma Tax Commission through its online Open Records form,
                under the Oklahoma Open Records Act ({p.requestStatute}). The
                request asked for:
              </span>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  the list of entities holding an active sales tax exemption
                  certificate under {p.statute}, the exemption for machinery and
                  equipment purchased by qualified computer services and data
                  processing businesses;
                </li>
                <li>
                  the list of establishments receiving Quality Jobs Program
                  incentive payments under 68 O.S. § 3601 et seq.
                </li>
              </ol>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Received</dt>
            <dd>
              {p.received}{" "}
              from the Oklahoma Tax Commission. The reply read: &ldquo;Please see
              the attached exemption reports. Additionally, you can find the list of
              quality job entities here:
              https://oktap.tax.ok.gov/OkTAP/Web?link=QLTYJOBSREBATE&rdquo;. The two
              attachments are the reports hosted on this page.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Statute</dt>
            <dd>
              {p.statute}, as named in the request; records requested under{" "}
              {p.requestStatute}.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Released by</dt>
            <dd>Oklahoma Tax Commission</dd>
          </div>
        </dl>
        <p className={BODY_CLASS}>
          The Quality Jobs list is not hosted here. The Commission&rsquo;s reply
          linked it at:{" "}
          <a
            href="https://oktap.tax.ok.gov/OkTAP/Web?link=QLTYJOBSREBATE"
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            oktap.tax.ok.gov/OkTAP/Web?link=QLTYJOBSREBATE
            {" "}
            <span className="sr-only">(opens in a new tab)</span>
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
            Both reports have five columns: Business Account ID, Entity Name, DBA
            Name, Mailing Address and Location Address. The Business Account ID
            column is empty in both released copies, so the tables omit it.
          </li>
          <li>
            Cells are shown as released. A cell the report leaves blank shows as a
            dash. Where an Entity Name is blank, the name appears only under DBA
            Name, and it is not moved.
          </li>
          <li>
            Long cells wrap across lines in the PDF and are joined with single
            spaces here. In the 80% report the name in row 20 wraps as
            &ldquo;HS&rdquo; and &ldquo;3&rdquo; across two lines, shown here as
            &ldquo;THE CONSTANT COMPANY HS 3&rdquo;.
          </li>
        </ul>
      </section>

      <section aria-labelledby="download-heading" className={SECTION_CLASS}>
        <p aria-hidden="true" className={EYEBROW_CLASS}>§ Download</p>
        <h2 id="download-heading" className="font-display text-2xl text-foreground">
          Download
        </h2>
        <p className={BODY_CLASS}>
          The SHA-256 below each file is that of the file as received; the hosted
          copy carries the same hash.
        </p>
        <ul className="max-w-2xl space-y-6">
          {p.files.map((f) => (
            <li key={f.list} className="space-y-2">
              <p className={BODY_CLASS}>
                <a href={f.filePath} download className={LINK_CLASS}>
                  Download the {f.list}% report (.pdf, {Math.round(f.byteSize / 1024)} KB)
                </a>
                . Received as{" "}
                <span className="font-mono text-sm">{f.receivedFileName}</span>;
                hosted as{" "}
                <span className="font-mono text-sm">
                  {f.filePath.slice(f.filePath.lastIndexOf("/") + 1)}
                </span>
                , {integer.format(f.byteSize)} bytes. Report Generated:{" "}
                {f.generated}. Total Active Accounts: {f.totalActiveAccounts}.
              </p>
              <p className="max-w-full break-all font-mono text-sm text-muted-foreground">
                SHA-256: <span>{f.sha256}</span>
              </p>
            </li>
          ))}
        </ul>
      </section>

      {p.files.map((f) => {
        const rows = OTC_1357_ROWS.filter((r) => r.list === f.list);
        const regionLabel = `${f.list}% report table`;
        return (
          <section
            key={f.list}
            aria-labelledby={`table-${f.list}-heading`}
            className={SECTION_CLASS}
          >
            <p aria-hidden="true" className={EYEBROW_CLASS}>§ The {f.list}% table</p>
            <h2
              id={`table-${f.list}-heading`}
              className="font-display text-2xl text-foreground"
            >
              {f.title}
            </h2>
            <p id={`table-${f.list}-hint`} className="text-sm text-muted-foreground">
              {rows.length} rows. The table scrolls horizontally on narrow screens.
              Each entity name links to its own row; where the entity name is
              blank, the dash links to it and is named by the DBA name.
            </p>
            <div
              role="region"
              aria-label={regionLabel}
              aria-describedby={`table-${f.list}-hint`}
              tabIndex={0}
              className="overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                <caption className="pb-3 text-left text-sm text-muted-foreground">
                  {f.title}, in the order of the released PDF.
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
                  {rows.map((r) => (
                    <tr
                      key={r.anchor}
                      id={r.anchor}
                      className="scroll-mt-20 border-b border-border align-top target:bg-muted target:outline target:outline-2 target:-outline-offset-2 target:outline-ring"
                    >
                      <RowHeader row={r} />
                      <td className="px-2 py-2"><Cell value={r.dbaName} /></td>
                      <td className="px-2 py-2"><Cell value={r.mailingAddress} /></td>
                      <td className="px-2 py-2"><Cell value={r.locationAddress} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
