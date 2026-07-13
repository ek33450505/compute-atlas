import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { createSubmission, listSubmissions, REVIEW_STATUSES } from "@/lib/submissions";

/** Admin-only: lists staged submissions, optionally filtered by `?status=`. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  if (status && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
    return jsonResponse({ error: "Invalid status parameter" }, { status: 400 });
  }

  const submissions = await listSubmissions(status);
  return jsonResponse({ count: submissions.length, submissions });
}

/** Admin-only: stages a new submission (create or update candidate). */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await createSubmission(body);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse({ id: result.id }, { status: 201 });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
