import type { ReactNode } from "react";

import { listSubmissions } from "@/lib/submissions";
import { REVIEW_STATUSES } from "@/lib/submissions";
import { SubmissionList } from "@/app/admin/submissions/submission-list";
import { SubmissionDetail } from "@/app/admin/submissions/submission-detail";

const DEFAULT_STATUS: (typeof REVIEW_STATUSES)[number] = "pending";

function normalizeStatus(raw: string | undefined): (typeof REVIEW_STATUSES)[number] {
  if (raw && (REVIEW_STATUSES as readonly string[]).includes(raw)) {
    return raw as (typeof REVIEW_STATUSES)[number];
  }
  return DEFAULT_STATUS;
}

export default async function AdminSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status = normalizeStatus(rawStatus);
  const submissions = await listSubmissions(status);

  // SubmissionDetail is an async Server Component. submission-list.tsx is a
  // "use client" file and cannot import-and-invoke it directly, so each row's
  // detail is pre-rendered here (a server component) and passed down as a
  // resolved node, keyed by submission id.
  const submissionDetails: Record<string, ReactNode> = {};
  for (const submission of submissions) {
    submissionDetails[submission.id] = <SubmissionDetail submission={submission} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Submissions</h1>
        <p className="text-sm text-muted-foreground">
          Review discovered and submitted facility candidates before they go live.
        </p>
      </div>
      <SubmissionList
        submissions={submissions}
        activeStatus={status}
        details={submissionDetails}
      />
    </div>
  );
}
