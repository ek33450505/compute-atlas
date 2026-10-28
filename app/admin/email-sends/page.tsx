import { getDb } from "@/lib/db/client";
import { EMAIL_SEND_KINDS, EMAIL_SEND_OUTCOMES } from "@/lib/email-sends";
import {
  countEmailSendsByOutcome,
  filterFromSearchParams,
  listEmailSends,
} from "@/lib/email-sends-query";
import { AddressLookupForm } from "@/app/admin/email-sends/address-lookup-form";
import { EmailSendsTable } from "@/app/admin/email-sends/email-sends-table";

// Cookie-gated (proxy.ts matches /admin/:path*) and DB-backed — see app/admin/contact/page.tsx.
export const dynamic = "force-dynamic";

type Param = string | string[] | undefined;

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

export default async function AdminEmailSendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>;
}) {
  const filter = filterFromSearchParams(await searchParams);
  const db = getDb();
  const [rows, counts] = await Promise.all([
    listEmailSends(db, filter),
    countEmailSendsByOutcome(db, filter),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Email sends</h1>
        <p className="text-sm text-muted-foreground">
          The send ledger, newest first. Addresses are stored only as salted hashes; the table
          shows the first 8 characters so rows for one address can be matched.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-kind" className="text-sm font-medium">
            Kind
          </label>
          <select id="filter-kind" name="kind" defaultValue={filter.kind ?? ""} className={selectClass}>
            <option value="">All</option>
            {EMAIL_SEND_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-outcome" className="text-sm font-medium">
            Outcome
          </label>
          <select
            id="filter-outcome"
            name="outcome"
            defaultValue={filter.outcome ?? ""}
            className={selectClass}
          >
            <option value="">All</option>
            {EMAIL_SEND_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-since" className="text-sm font-medium">
            From
          </label>
          <input
            id="filter-since"
            name="since"
            type="date"
            defaultValue={filter.since ?? ""}
            className={selectClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="filter-until" className="text-sm font-medium">
            To
          </label>
          <input
            id="filter-until"
            name="until"
            type="date"
            defaultValue={filter.until ?? ""}
            className={selectClass}
          />
        </div>
        <button
          type="submit"
          className="h-8 rounded-md border border-input px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          Apply filters
        </button>
      </form>

      <section aria-labelledby="outcome-counts-heading" className="flex flex-col gap-2">
        <h2 id="outcome-counts-heading" className="text-base font-semibold">
          Counts by outcome
        </h2>
        {Object.keys(counts).length === 0 ? (
          <p className="text-sm text-muted-foreground">No sends match.</p>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {Object.entries(counts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([outcome, n]) => (
                <li key={outcome}>
                  {outcome}: {n}
                </li>
              ))}
          </ul>
        )}
      </section>

      <EmailSendsTable rows={rows} caption={`Email sends, newest first (up to ${rows.length} shown)`} />

      <AddressLookupForm />
    </div>
  );
}
