/**
 * Cache-tag busting for tsx CLIs, shared by `db:sync` and the closed-data writers
 * (`siting:apply`, `backfill:siting`, `backfill:ownership`). A standalone process
 * has no Next runtime and cannot call `revalidateTag`, so it POSTs the
 * admin-bearer `/api/revalidate` route instead.
 *
 * Uses relative imports, matching the other scripts here.
 */
import { isValidCacheTag, MAX_TAGS_PER_REQUEST } from "../lib/cache-tags";
import { RefusalError, type KeyedStore } from "../lib/closed-data-store";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface BustTagsResult {
  batches: number;
  bustedTags: string[];
  failedTags: string[];
  errors: string[];
}

/**
 * Busts cache tags through `POST /api/revalidate`. A standalone tsx process
 * has no Next runtime and so cannot call `revalidateTag` itself — this route
 * exists for exactly this caller.
 *
 * Batched to `MAX_TAGS_PER_REQUEST`, and a failing batch does not strand the
 * rest: every failure is reported with its tags so the operator can retry
 * precisely.
 */
export async function bustTags(
  tags: string[],
  options: { baseUrl: string; token: string; fetchImpl?: typeof fetch }
): Promise<BustTagsResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const result: BustTagsResult = { batches: 0, bustedTags: [], failedTags: [], errors: [] };
  // Defense in depth: callers validate before writing, but a bad tag must never reach the route.
  assertValidTags(tags);

  for (let i = 0; i < tags.length; i += MAX_TAGS_PER_REQUEST) {
    const batch = tags.slice(i, i + MAX_TAGS_PER_REQUEST);
    result.batches++;
    try {
      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/api/revalidate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: batch }),
      });

      if (!res.ok) {
        // Status and tag chunk only: a response body may echo request data.
        result.failedTags.push(...batch);
        result.errors.push(`HTTP ${res.status} [${batch.join(", ")}]`);
        try {
          await res.body?.cancel(); // release the socket; the body is never read
        } catch {
          // best effort
        }
        continue;
      }

      result.bustedTags.push(...batch);
    } catch (err) {
      result.failedTags.push(...batch);
      // Fixed string: a raw fetch message can carry the URL.
      result.errors.push("network error");
    }
  }

  return result;
}

export interface RevalidateConfig {
  baseUrl: string;
  token: string;
}

/**
 * Pre-flight for a writer that busts after `--apply`. Returns null when no bust
 * is wanted (dry run, or `--skip-revalidate`); throws before any write when a
 * bust is wanted but cannot be made. No localhost default for the base URL: that
 * would write prod Neon and bust a dev server's cache. The bearer token is sent to
 * the base URL, so it must be https (plain http only for a loopback dev server).
 */
export function resolveRevalidate(opts: {
  apply: boolean;
  skipRevalidate: boolean;
  env: Record<string, string | undefined>;
}): RevalidateConfig | null {
  if (!opts.apply || opts.skipRevalidate) return null;
  const baseUrl = opts.env.API_BASE_URL;
  const token = opts.env.API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new RefusalError(
      "Refusing to apply: --apply busts cache tags over HTTP and needs both API_BASE_URL and " +
        "API_ADMIN_TOKEN in .env.local.\n" +
        `  API_BASE_URL: ${baseUrl ? "(set)" : "(unset)"}\n` +
        `  API_ADMIN_TOKEN: ${token ? "(set)" : "(unset)"}\n` +
        "Set them, or pass --skip-revalidate to write without busting (pages stay stale).",
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RefusalError("Refusing to apply: API_BASE_URL is not a valid URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new RefusalError(
      `Refusing to apply: API_BASE_URL uses ${url.protocol}//${url.hostname}; the admin token is only sent over https ` +
        "(http is allowed for localhost and 127.0.0.1 only).",
    );
  }
  return { baseUrl, token };
}

/** Reduces bustTags errors to status codes or "network error": bodies and fetch messages can carry a URL or token. */
export function bustErrorSummary(errors: string[]): string {
  return [...new Set(errors.map((e) => /^HTTP (\d{3})/.exec(e)?.[1] ?? "network error"))].join(", ");
}

const MAX_NAMED_TAGS = 20;

/** Names at most MAX_NAMED_TAGS tags so a large failed bust cannot flood the log line. */
function namedTags(tags: string[]): string {
  const shown = tags.slice(0, MAX_NAMED_TAGS).join(", ");
  return tags.length > MAX_NAMED_TAGS ? `${shown} (+${tags.length - MAX_NAMED_TAGS} more)` : shown;
}

/** Throws if the revalidate route would reject any tag; call BEFORE writing. */
export function assertValidTags(tags: string[]): void {
  const invalid = tags.filter((tag) => !isValidCacheTag(tag));
  if (invalid.length > 0) {
    throw new RefusalError(
      `Refusing to proceed: ${invalid.length} planned cache tag(s) are outside the allowlist in lib/cache-tags.ts: ${invalid.join(", ")}`,
    );
  }
}

/**
 * Busts `tags` after a successful write. A failure never undoes the write: it logs a
 * warning carrying status codes only (never the URL or token) and throws, so the CLI
 * exits non-zero. `config` null means the operator passed --skip-revalidate.
 */
export async function bustAfterWrite(
  tags: string[],
  config: RevalidateConfig | null,
  deps: { log: (line: string) => void; fetchImpl?: typeof fetch },
): Promise<void> {
  if (tags.length === 0) return;
  if (config === null) {
    deps.log(
      `WARNING: --skip-revalidate: wrote without busting ${tags.length} cache tag(s); the affected pages stay stale for up to 24h.`,
    );
    return;
  }
  const bust = await bustTags(tags, { ...config, fetchImpl: deps.fetchImpl });
  deps.log(`Busted ${bust.bustedTags.length} tag(s) in ${bust.batches} request(s).`);
  if (bust.failedTags.length > 0) {
    throw new RefusalError(
      `WARNING: the write succeeded and is kept, but ${bust.failedTags.length} cache tag(s) failed to bust ` +
        `(${bustErrorSummary(bust.errors)}): ${namedTags(bust.failedTags)}. Re-bust them via POST /api/revalidate; the pages stay stale up to 24h otherwise.`,
    );
  }
}

/**
 * Runs `op` (a write against `store`) and then busts the tags for every row that was upserted,
 * whether `op` finished or threw. The rows passed to `upsert` (inserts AND updates, so a
 * future backfill that overwrites is covered) are recorded before it runs, which means a failed read-back verify,
 * which throws AFTER the rows landed, still evicts the stale pages; busting only evicts cache,
 * so doing it on a verify failure is safe. The original error is rethrown; a bust failure
 * then is only logged.
 */
export async function bustAfterUpserts<T>(
  opts: {
    store: KeyedStore;
    tagsFor: (keys: string[]) => string[];
    config: RevalidateConfig | null;
    deps: { log: (line: string) => void; fetchImpl?: typeof fetch };
  },
  op: (store: KeyedStore) => Promise<T>,
): Promise<T> {
  const written: string[] = [];
  const recording: KeyedStore = {
    readAll: () => opts.store.readAll(),
    async upsert(rows) {
      // Recorded before the await so a throw mid-upsert still reports the keys in flight.
      written.push(...rows.map((r) => r.key));
      await opts.store.upsert(rows);
    },
  };
  let result: T;
  try {
    result = await op(recording);
  } catch (err) {
    if (written.length > 0) {
      try {
        await bustAfterWrite(opts.tagsFor(written), opts.config, opts.deps);
      } catch (bustErr) {
        opts.deps.log(bustErr instanceof Error ? bustErr.message : "cache bust failed");
      }
    }
    throw err;
  }
  if (written.length > 0) await bustAfterWrite(opts.tagsFor(written), opts.config, opts.deps);
  return result;
}
