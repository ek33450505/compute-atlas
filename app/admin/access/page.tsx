import { redirect } from "next/navigation";

import { AccessQueue } from "@/app/admin/access/access-queue";
import { DownloadLog } from "@/app/admin/access/download-log";
import { GrantsList } from "@/app/admin/access/grants-list";
import { toListGrant, toQueueGrant } from "@/app/admin/access/grant-views";
import { hasAdminSession } from "@/lib/admin-session";
import {
  getDatasetDownloadLog,
  listDatasetGrantsForAdmin,
  listDatasetReviewQueue,
} from "@/lib/dataset-admin";
import { DATASET_GRANT_STATUSES, type DatasetGrantStatus } from "@/lib/db/schema";

// Cookie-gated (proxy.ts matches /admin/:path*, and the page re-checks the session itself) and DB-backed —
// prerendering this at build time would run the queries with no DATABASE_URL available, which aborts the
// build. Render on demand instead.
export const dynamic = "force-dynamic";

const DEFAULT_STATUS: DatasetGrantStatus = "active";

function normalizeStatus(raw: string | undefined): DatasetGrantStatus {
  if (raw && (DATASET_GRANT_STATUSES as readonly string[]).includes(raw)) {
    return raw as DatasetGrantStatus;
  }
  return DEFAULT_STATUS;
}

export default async function AdminAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; grant?: string }>;
}) {
  // Defense in depth: this page reads PII, so it does not rely on the proxy alone.
  if (!(await hasAdminSession())) redirect("/admin/login");

  const { status: rawStatus, grant } = await searchParams;
  const status = normalizeStatus(rawStatus);

  const [queue, grants] = await Promise.all([
    listDatasetReviewQueue(),
    listDatasetGrantsForAdmin(status),
  ]);
  // The lib rejects a malformed id before any DB call, so the raw param goes straight through.
  const log = typeof grant === "string" ? await getDatasetDownloadLog(grant) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-heading text-xl font-semibold">Dataset access</h1>
        <p className="text-sm text-muted-foreground">
          Requests for the full dataset, reviewed by hand. Approved requesters get a personal link
          by email.
        </p>
      </div>
      <AccessQueue grants={queue.map(toQueueGrant)} />
      {/* Above the list: the list's "Download log" links load it, so it must sit right after the queue,
          not below every row. Keyed by grant so opening a different log remounts it and re-focuses it. */}
      {log !== undefined ? (
        <DownloadLog key={grant} log={log} closeHref={`/admin/access?status=${status}`} />
      ) : null}
      <GrantsList grants={grants.map(toListGrant)} activeStatus={status} />
    </div>
  );
}
