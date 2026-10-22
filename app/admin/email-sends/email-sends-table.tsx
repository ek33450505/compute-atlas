import type { EmailSendListed } from "@/lib/email-sends-query";

export type EmailSendsTableRow = Omit<EmailSendListed, "createdAt" | "completedAt"> & {
  createdAt: Date | string;
  completedAt: Date | string | null;
};

function formatTime(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

const dash = (value: string | null) => value ?? "—";

/** Ledger rows. Shows the 8-character hash prefix only, never the full hash or an address. */
export function EmailSendsTable({ rows, caption }: { rows: EmailSendsTableRow[]; caption: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No sends match.</p>;
  }
  return (
    <div
      role="region"
      aria-label="Email sends table, scrolls horizontally"
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full text-left text-xs">
        <caption className="px-3 py-2 text-left text-sm text-muted-foreground">{caption}</caption>
        <thead className="border-b border-border bg-muted/40">
          <tr>
            {[
              "Created",
              "Completed",
              "Kind",
              "Outcome",
              "Target",
              "Run",
              "Resend ID",
              "Error code",
              "Subscription",
              "Address hash",
            ].map((heading) => (
              <th key={heading} scope="col" className="px-3 py-2 font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap px-3 py-2">{formatTime(row.createdAt)}</td>
              <td className="whitespace-nowrap px-3 py-2">{formatTime(row.completedAt)}</td>
              <td className="px-3 py-2">{row.kind}</td>
              <td className="px-3 py-2">{row.outcome}</td>
              <td className="px-3 py-2">
                {row.targetType ? `${row.targetType}${row.targetId ? `: ${row.targetId}` : ""}` : "—"}
              </td>
              <td className="px-3 py-2 font-mono">{dash(row.runId)}</td>
              <td className="px-3 py-2 font-mono">{dash(row.resendId)}</td>
              <td className="px-3 py-2">{dash(row.errorCode)}</td>
              <td className="px-3 py-2 font-mono">{dash(row.subscriptionId)}</td>
              <td className="px-3 py-2 font-mono">{row.hashPrefix}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
