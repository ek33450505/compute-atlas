/**
 * CLI review tool for the submissions staging queue. Hits the API (rather
 * than the DB directly) so `approve` runs inside Next and can call
 * `revalidateTag` — a standalone script talking straight to Neon can't.
 *
 * Run via: npm run submissions -- <command> [args]
 * Requires API_ADMIN_TOKEN in .env.local; API_BASE_URL defaults to
 * http://localhost:3000.
 *
 * Approving a submission emails every confirmed watcher of the facility it
 * writes (a `create`'s payload.id, otherwise its target). `list` marks those rows, and `approve` refuses (exit 2,
 * nothing approved) when the row has watchers unless `--notify-watchers` is
 * passed: `approve <id> [note] [--notify-watchers]`. The flag is also sent to the
 * approve endpoint, which enforces the same rule server-side (409).
 *
 * Uses relative imports throughout, matching the other scripts in this folder.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.API_ADMIN_TOKEN;

const NOTIFY_WATCHERS_FLAG = "--notify-watchers";

/** The slice of `GET /api/submissions` rows this CLI reads. */
export interface ListedSubmission {
  id: string;
  kind: string;
  status: string;
  targetFacilityId: string | null;
  createdAt: string;
  provenance: { sources?: string[] };
  payload?: unknown;
  /** Confirmed facility-watchers an approval would email. Absent on a server that predates it. */
  watcherCount?: number;
}

/**
 * Splits `approve`'s arguments into id, note and the watcher opt-in. The flag
 * may appear anywhere and never ends up in the note text.
 */
export function parseApproveArgs(args: string[]): {
  id: string | undefined;
  note: string | undefined;
  notifyWatchers: boolean;
} {
  const notifyWatchers = args.includes(NOTIFY_WATCHERS_FLAG);
  const [id, ...noteWords] = args.filter((a) => a !== NOTIFY_WATCHERS_FLAG);
  return { id, note: noteWords.join(" ") || undefined, notifyWatchers };
}

/**
 * The JSON body for the approve call. `notifyWatchers: true` is sent only when
 * the flag was passed — the server refuses (409) a row with watchers without
 * it, so the opt-in has to travel to the server as well as satisfy the CLI.
 */
export function approveBody(
  note: string | undefined,
  notifyWatchers: boolean
): { reviewNote?: string; notifyWatchers?: true } {
  return { reviewNote: note, ...(notifyWatchers ? { notifyWatchers: true as const } : {}) };
}

/**
 * The facility id an approval writes — the one whose watchers it mails. Mirrors
 * the server's rule (`approvedFacilityId` in lib/submissions.ts): a `create`
 * is keyed on `payload.id`, anything else on `targetFacilityId`. `null` when
 * the row carries no usable id.
 */
export function approvedFacilityId(
  row: Pick<ListedSubmission, "kind" | "targetFacilityId" | "payload">
): string | null {
  if (row.kind === "create") {
    const id = (row.payload as Record<string, unknown> | null | undefined)?.id;
    return typeof id === "string" && id !== "" ? id : null;
  }
  return row.targetFacilityId || null;
}

/**
 * Decides whether `approve` may proceed. A row whose watcher count the server
 * did not report is treated as UNKNOWN, not zero: reading a missing field as 0
 * would turn this gate off exactly when it cannot see.
 */
export function approveGate(
  row: Pick<ListedSubmission, "id" | "kind" | "targetFacilityId" | "payload" | "watcherCount">,
  notifyWatchers: boolean
): { ok: true } | { ok: false; reason: string } {
  if (notifyWatchers) return { ok: true };

  const n = row.watcherCount;
  if (typeof n !== "number") {
    return {
      ok: false,
      reason:
        `Refusing: the server did not report a watcher count for ${row.id}, so it cannot be ` +
        `checked. Re-run with ${NOTIFY_WATCHERS_FLAG} to approve anyway.`,
    };
  }
  if (n > 0) {
    return {
      ok: false,
      reason:
        `Refusing: approving ${row.id} emails ${n} confirmed watcher(s) of ` +
        `${approvedFacilityId(row) ?? "-"}. Re-run with ${NOTIFY_WATCHERS_FLAG} to send.`,
    };
  }
  return { ok: true };
}

/** The lines `list` prints for one row; a row with watchers carries a marker line. */
export function formatListEntry(s: ListedSubmission): string[] {
  const lines = [
    `- ${s.id}  ${s.kind}  ${s.status}  target=${s.targetFacilityId ?? "-"}  created=${s.createdAt}`,
    `  sources: ${(s.provenance.sources ?? []).join(", ") || "(none)"}`,
  ];
  if (typeof s.watcherCount === "number" && s.watcherCount > 0) {
    lines.push(`  ⚠ emails ${s.watcherCount} confirmed watcher(s) on approve`);
  }
  return lines;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: authHeaders() });
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    console.error(`Request failed: ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

async function list(status?: string): Promise<void> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = (await request(`/api/submissions${qs}`)) as {
    count: number;
    submissions: ListedSubmission[];
  };

  console.log(`${data.count} submission(s):`);
  for (const s of data.submissions) {
    for (const line of formatListEntry(s)) console.log(line);
  }
}

async function approve(id: string, note: string | undefined, notifyWatchers: boolean): Promise<void> {
  // Look the row up BEFORE approving: once the approve call lands, the watcher
  // emails are already sent. A row that is not in the pending list (unknown id,
  // or already reviewed) is left to the approve endpoint, which rejects it with
  // 404/409 before it writes or mails anything — the same failure as before.
  const pending = (await request("/api/submissions?status=pending")) as {
    submissions?: ListedSubmission[];
  };
  if (!Array.isArray(pending.submissions)) {
    console.error("Unexpected response listing pending submissions; nothing was approved.");
    process.exit(1);
  }
  const row = pending.submissions.find((s) => s.id === id);
  if (row) {
    const gate = approveGate(row, notifyWatchers);
    if (!gate.ok) {
      console.error(gate.reason);
      process.exit(2);
    }
  }

  const data = await request(`/api/submissions/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(approveBody(note, notifyWatchers)),
  });
  printJson(data);
}

async function reject(id: string, reason: string): Promise<void> {
  const data = await request(`/api/submissions/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  printJson(data);
}

async function submit(filePath: string): Promise<void> {
  const raw = readFileSync(filePath, "utf-8");
  const data = await request("/api/submissions", {
    method: "POST",
    body: raw,
  });
  printJson(data);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("API_ADMIN_TOKEN is not set. Configure it in .env.local before using this CLI.");
    process.exit(1);
  }

  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "list":
      await list(args[0]);
      break;
    case "approve": {
      const { id, note, notifyWatchers } = parseApproveArgs(args);
      if (!id) {
        console.error(`Usage: submissions approve <id> [note] [${NOTIFY_WATCHERS_FLAG}]`);
        process.exit(1);
      }
      await approve(id, note, notifyWatchers);
      break;
    }
    case "reject":
      if (!args[0] || args.length < 2) {
        console.error("Usage: submissions reject <id> <reason...>");
        process.exit(1);
      }
      await reject(args[0], args.slice(1).join(" "));
      break;
    case "submit":
      if (!args[0]) {
        console.error("Usage: submissions submit <path-to-json>");
        process.exit(1);
      }
      await submit(args[0]);
      break;
    default:
      console.error("Usage: submissions <list|approve|reject|submit> [args]");
      process.exit(1);
  }
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — same guard as scripts/check-googlebot-access.ts.
// Compared as pathToFileURL(realpath(argv[1])): import.meta.url is percent-encoded
// and symlink-resolved, argv[1] is neither. A raw `file://${argv[1]}` never
// matches a path with a space, and even pathToFileURL alone never matches one
// reached through a symlink (e.g. macOS /var -> /private/var) — in both cases
// the CLI would silently do nothing.
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
const isMain = isEntrypoint();
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
