import { listLeadsForAdmin, LEAD_STATUSES, type LeadStatus } from "@/lib/leads";
import { LeadList } from "@/app/admin/leads/lead-list";

const DEFAULT_STATUS: LeadStatus = "new";

function normalizeStatus(raw: string | undefined): LeadStatus {
  if (raw && (LEAD_STATUSES as readonly string[]).includes(raw)) {
    return raw as LeadStatus;
  }
  return DEFAULT_STATUS;
}

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status = normalizeStatus(rawStatus);
  const leads = await listLeadsForAdmin(status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-xl font-semibold">Leads</h1>
        <p className="text-sm text-muted-foreground">
          Triage public tips — bare URLs and notes submitted anonymously — before researching them
          into a submission.
        </p>
      </div>
      <LeadList leads={leads} activeStatus={status} />
    </div>
  );
}
