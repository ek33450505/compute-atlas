import Link from "next/link";

import { FocusOnMount } from "@/app/admin/access/focus-on-mount";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ADMIN_DOWNLOAD_LOG_LIMIT, type AdminDatasetDownloadLog } from "@/lib/dataset-admin";

// Focus lands here when the log opens, so it carries the same visible ring as other focus targets.
const HEADING_CLASS =
  "font-heading text-lg font-semibold rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent";

// UTC and fixed-format so the text never depends on the server's locale or timezone.
function formatTime(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function DownloadLog({
  log,
  closeHref,
}: {
  log: AdminDatasetDownloadLog | null;
  closeHref?: string;
}) {
  if (log === null) {
    return (
      <section aria-labelledby="download-log-heading" className="flex flex-col gap-2">
        <h2 id="download-log-heading" tabIndex={-1} className={HEADING_CLASS}>
          Download log
        </h2>
        <FocusOnMount targetId="download-log-heading" />
        <p className="text-sm text-muted-foreground">No such grant.</p>
        {closeHref ? <CloseLink href={closeHref} /> : null}
      </section>
    );
  }

  const { grant, downloads } = log;

  return (
    <section aria-labelledby="download-log-heading" className="flex flex-col gap-3">
      <h2 id="download-log-heading" tabIndex={-1} className={HEADING_CLASS}>
        Download log: {grant.name}
      </h2>
      <FocusOnMount targetId="download-log-heading" />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Email</dt>
        <dd>{grant.email}</dd>
        <dt className="text-muted-foreground">Total downloads</dt>
        <dd>{grant.downloadCount}</dd>
        <dt className="text-muted-foreground">Last download</dt>
        <dd>
          {grant.lastDownloadAt ? (
            <time dateTime={grant.lastDownloadAt.toISOString()}>
              {formatTime(grant.lastDownloadAt)}
            </time>
          ) : (
            "Never"
          )}
        </dd>
      </dl>
      {downloads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No downloads recorded.</p>
      ) : (
        <Table>
          <TableCaption>
            Newest {ADMIN_DOWNLOAD_LOG_LIMIT} entries at most, newest first.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Time</TableHead>
              <TableHead scope="col">File</TableHead>
              <TableHead scope="col">Outcome</TableHead>
              <TableHead scope="col">Edition</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {downloads.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <time dateTime={d.createdAt.toISOString()}>{formatTime(d.createdAt)}</time>
                </TableCell>
                <TableCell>{d.file}</TableCell>
                <TableCell>{d.outcome}</TableCell>
                <TableCell>
                  {d.editionId ? (
                    <>
                      <span aria-hidden="true" title={d.editionId}>
                        {d.editionId.slice(0, 8)}
                      </span>
                      <span className="sr-only">{d.editionId}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {closeHref ? <CloseLink href={closeHref} /> : null}
    </section>
  );
}

function CloseLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-6 items-center text-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      Close log
    </Link>
  );
}
