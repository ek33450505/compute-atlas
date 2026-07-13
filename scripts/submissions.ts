/**
 * CLI review tool for the submissions staging queue. Hits the API (rather
 * than the DB directly) so `approve` runs inside Next and can call
 * `revalidateTag` — a standalone script talking straight to Neon can't.
 *
 * Run via: npm run submissions -- <command> [args]
 * Requires API_ADMIN_TOKEN in .env.local; API_BASE_URL defaults to
 * http://localhost:3000.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, which is a Next.js/tsconfig-plugin feature, not a Node runtime one.
 */
import { readFileSync } from "node:fs";

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.API_ADMIN_TOKEN;

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
    submissions: Array<{
      id: string;
      kind: string;
      status: string;
      targetFacilityId: string | null;
      createdAt: string;
      provenance: { sources?: string[] };
    }>;
  };

  console.log(`${data.count} submission(s):`);
  for (const s of data.submissions) {
    console.log(
      `- ${s.id}  ${s.kind}  ${s.status}  target=${s.targetFacilityId ?? "-"}  created=${s.createdAt}`
    );
    console.log(`  sources: ${(s.provenance.sources ?? []).join(", ") || "(none)"}`);
  }
}

async function approve(id: string, note?: string): Promise<void> {
  const data = await request(`/api/submissions/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ reviewNote: note }),
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
    case "approve":
      if (!args[0]) {
        console.error("Usage: submissions approve <id> [note]");
        process.exit(1);
      }
      await approve(args[0], args.slice(1).join(" ") || undefined);
      break;
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
