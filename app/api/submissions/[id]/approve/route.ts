import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { redactedErrorCode } from "@/lib/db-error";
import { approvalWatcherCount, approveSubmission } from "@/lib/submissions";

/**
 * Admin-only: promotes a pending submission to a live facility.
 *
 * Approving emails every confirmed watcher of the facility the approval writes
 * (a `create`'s `payload.id`, otherwise the target), so this refuses with 409
 * (approving nothing) when the row has watchers and the body does not carry
 * `notifyWatchers: true`. That is what stops a raw call from bypassing the CLI's
 * `--notify-watchers` check. If the watcher check itself fails it refuses with
 * 503 rather than approving unchecked. The gate lives here, not in
 * `approveSubmission`: the admin UI's server actions call that directly and are
 * a separate, human-in-the-loop path.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;

  let reviewNote: string | undefined;
  let notifyWatchers = false;
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      if ("reviewNote" in body) {
        reviewNote = (body as { reviewNote?: string }).reviewNote;
      }
      // Strictly `true`: a truthy string or number is not an opt-in.
      notifyWatchers = (body as { notifyWatchers?: unknown }).notifyWatchers === true;
    }
  } catch {
    // Tolerate an empty/missing body — reviewNote is optional.
  }

  if (!notifyWatchers) {
    let watcherCount: number;
    try {
      watcherCount = await approvalWatcherCount(id);
    } catch (err) {
      // Fail closed: an unverifiable watcher count must not read as "none".
      // SQLSTATE only — the caught error embeds the query's bound params.
      console.error(`approve watcher check failed (sqlstate: ${redactedErrorCode(err)})`);
      return jsonResponse(
        { error: "could not verify watchers; approval refused" },
        { status: 503 }
      );
    }
    if (watcherCount > 0) {
      return jsonResponse(
        { error: "approval would email confirmed watchers", watcherCount },
        { status: 409 }
      );
    }
  }

  const result = await approveSubmission(id, reviewNote);
  if (!result.ok) {
    return jsonResponse({ error: result.error, issues: result.issues }, { status: result.status });
  }
  return jsonResponse({ submission: result.submission, facility: result.facility });
}

// `admin`: the only handler here is a bearer-gated POST, so `Authorization`
// genuinely has to be advertised.
export function OPTIONS(): Response {
  return corsPreflight("admin");
}
