import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { rejectSubmission } from "@/lib/submissions";

/** Admin-only: rejects a pending submission with a required reason. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }
  const reason = (body as { reason?: string } | null)?.reason ?? "";

  const result = await rejectSubmission(id, reason);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, { status: result.status });
  }
  return jsonResponse({ submission: result.submission });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
