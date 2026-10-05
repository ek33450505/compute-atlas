import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin, requireIntake } from "@/lib/api-auth";
import { createSubmission, listSubmissionsWithWatchers, REVIEW_STATUSES } from "@/lib/submissions";

/**
 * Admin-only: lists staged submissions, optionally filtered by `?status=`.
 * Each row carries `watcherCount` — how many confirmed facility-watchers its
 * approval would email — so a reviewer can see it before approving.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  if (status && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
    return jsonResponse({ error: "Invalid status parameter" }, { status: 400 });
  }

  const submissions = await listSubmissionsWithWatchers(status);
  return jsonResponse({ count: submissions.length, submissions });
}

/**
 * Stages a new submission (create or update candidate) as `pending`.
 *
 * The ONE route that accepts the least-privilege `API_INTAKE_TOKEN` as well as
 * `API_ADMIN_TOKEN` (see `requireIntake`) — staging is all the discovery
 * pipeline needs, and everything that can publish, approve, or sign an admin
 * cookie stays behind `requireAdmin`. `GET` above deliberately does NOT accept
 * the intake token: reading the whole staging queue is not a write capability
 * the pipeline needs. Do not widen `requireIntake` past this handler.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireIntake(request);
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

// `admin` — the same value the bare default already produced, so this is inert
// at runtime and written down anyway. `GET` is behind `requireAdmin` and `POST`
// accepts the least-privilege `API_INTAKE_TOKEN` as well; both read a bearer
// token, so `Authorization` genuinely has to be advertised. Stating the posture
// is the point: `lib/api-response.test.ts` asserts every route names its own
// rather than inheriting one, so the day the default changes this path does not
// move with it.
export function OPTIONS(): Response {
  return corsPreflight("admin");
}
