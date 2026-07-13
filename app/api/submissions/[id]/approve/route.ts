import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { approveSubmission } from "@/lib/submissions";

/** Admin-only: promotes a pending submission to a live facility. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;

  let reviewNote: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && "reviewNote" in body) {
      reviewNote = (body as { reviewNote?: string }).reviewNote;
    }
  } catch {
    // Tolerate an empty/missing body — reviewNote is optional.
  }

  const result = await approveSubmission(id, reviewNote);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse({ submission: result.submission, facility: result.facility });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
