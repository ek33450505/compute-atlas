/**
 * Thin, injectable HTTP client for a LOCAL Ollama instance's chat API.
 *
 * LOCAL MODELS ONLY. A `:cloud`-suffixed model (e.g. "gpt-oss:20b-cloud")
 * silently returns prose instead of erroring when a JSON `format` schema is
 * requested (https://github.com/ollama/ollama/issues/13206) — never
 * construct a `:cloud` model string here. This client assumes every model
 * it is pointed at is running locally with genuine grammar-constrained
 * decoding.
 *
 * Always POSTs to `/api/chat`, never `/api/generate`. Measured directly
 * against gpt-oss:20b on Ollama 0.32.7: `/api/generate` with a `format`
 * schema returns `response: ""` — an EMPTY STRING — with `done_reason:
 * "stop"` and a non-zero `eval_count`. It looks exactly like a successful
 * call and would be read downstream as a false "not_mentioned" verdict.
 * `/api/chat` works correctly: the JSON lands in `message.content`; a
 * reasoning model's chain-of-thought lands in `message.thinking`, which
 * this client never reads and callers must not rely on.
 */

export interface CallOllamaOptions {
  baseUrl?: string;
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: object;
  fetchImpl: typeof fetch;
  /** Context window size, tokens. ALWAYS sent explicitly (never left to
   * Ollama's own default) — see design rule 6 in the source plan. */
  numCtx?: number;
  /**
   * Per-call abort timeout, ms. Defaults to `OLLAMA_TIMEOUT_MS` if it parses
   * as a positive number, else `DEFAULT_TIMEOUT_MS` (120_000 / 2 minutes) —
   * see that constant's doc-comment for why 2 minutes is the right default.
   */
  timeoutMs?: number;
}

export type CallOllamaResult<T> = { ok: true; data: T } | { ok: false; reason: string };

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gpt-oss:20b";
const DEFAULT_NUM_CTX = 32768;
/**
 * Deliberately generous, not tight. This client is called on every source
 * check by the discovery gate, which runs UNATTENDED at 13:00 via launchd —
 * `/api/chat` with `stream:false` holds the connection open until generation
 * completes, so with NO timeout at all a wedged Ollama, a heavily loaded
 * machine, or a huge prompt stalls a run forever. But an over-eager timeout
 * is its own failure mode here: a timed-out call returns `{ ok: false }`,
 * which verify-source.ts's design rule 6 maps straight to VerificationResult
 * "unavailable" — a hard stop for the WHOLE gate run, not a per-call retry.
 * Measured normal latency for `gpt-oss:20b` against a local Ollama is ~3.0s,
 * so 120s (2 minutes) only fires when something is genuinely wrong —
 * roughly 40x headroom over the observed happy path, not a bound tuned
 * tightly to it.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

interface OllamaChatResponse {
  message?: {
    content?: string;
    /** Reasoning-model chain-of-thought. Intentionally never read. */
    thinking?: string;
  };
}

/**
 * Resolves the abort timeout: an explicit `opts.timeoutMs` always wins, then
 * `OLLAMA_TIMEOUT_MS` if it parses as a positive finite number, else
 * `DEFAULT_TIMEOUT_MS`. Guards against `Number(garbage)` producing `NaN` (or
 * a non-positive value) and silently arming `setTimeout` with an
 * effectively-zero delay, which would make every call time out immediately.
 */
function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.OLLAMA_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Calls a local Ollama model with a JSON-schema-constrained chat request.
 * Never throws — every failure mode (network error, non-2xx, empty content,
 * malformed JSON, unexpected content shape, timeout) resolves to
 * `{ ok: false, reason }`.
 */
export async function callOllama<T>(opts: CallOllamaOptions): Promise<CallOllamaResult<T>> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
  const model = opts.model ?? process.env.OLLAMA_VERIFY_MODEL ?? DEFAULT_MODEL;
  const numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  const requestBody = {
    model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    format: opts.jsonSchema,
    stream: false,
    options: {
      temperature: 0,
      num_ctx: numCtx,
    },
  };

  // Armed for the WHOLE call — the POST and the JSON body read — and cleared
  // exactly once, in `finally`, however the call concludes. Mirrors the
  // timer discipline in fetch-page-text.ts: a stalled body read after
  // headers arrive is just as much a hang as a stalled connection, so the
  // same signal has to cover both.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await opts.fetchImpl(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch {
      // Distinguish OUR abort from a genuine network error so callers (and
      // the log) can tell "Ollama took too long" apart from "Ollama is
      // unreachable" — both still collapse to "unavailable" one level up in
      // verify-source.ts, but the underlying reason stays diagnosable.
      return controller.signal.aborted ? { ok: false, reason: "timeout" } : { ok: false, reason: "network_error" };
    }

    if (!res.ok) {
      return { ok: false, reason: `http_error_${res.status}` };
    }

    let parsed: OllamaChatResponse;
    try {
      parsed = (await res.json()) as OllamaChatResponse;
    } catch {
      return controller.signal.aborted ? { ok: false, reason: "timeout" } : { ok: false, reason: "invalid_response_json" };
    }

    const content = parsed.message?.content;
    // Empty or whitespace-only content is the specific regression this client
    // guards against — see the /api/generate trap in the file doc-comment.
    // Never treat it as a silently-empty success.
    if (!content || content.trim().length === 0) {
      return { ok: false, reason: "empty_content" };
    }

    try {
      const data = JSON.parse(content) as T;
      // Generic floor only — `callOllama<T>` can't validate T's own fields
      // (e.g. ModelVerdict's enum/quote shape; that's verify-source.ts's
      // job). This just rules out the other shapes valid JSON can produce —
      // array, null, or a bare string/number/boolean — which would otherwise
      // reach a caller expecting object fields and throw a TypeError instead
      // of failing cleanly here.
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return { ok: false, reason: "invalid_content_shape" };
      }
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "malformed_json_content" };
    }
  } finally {
    clearTimeout(timer);
  }
}
