/**
 * Bounded JSON body reader for the public intake POSTs.
 *
 * `request.json()` buffers whatever arrives, so Vercel's 4.5 MB platform limit
 * was the only bound. This enforces ours in two steps, on purpose: a declared
 * `content-length` over the cap is refused before a byte is read, and the
 * stream is then counted as it arrives, because the header is caller-supplied
 * and may be absent (chunked) or a lie. The header is an optimisation, never
 * the bound.
 */

/**
 * Default cap for public JSON intake. The largest legitimate payload is a
 * `contribute` create/correction: a handful of short strings plus `note`
 * (<= 2000 chars) and a URL (<= 2000 chars) is about 5 KB even with every
 * character escaped to `\uXXXX` ~ 6x for the worst case (~25 KB). 64 KiB
 * leaves headroom for that without being a useful amplification channel.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type ReadBodyTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "read_error" };

export type ReadJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" | "invalid_json" };

/** Capped streaming read of the request body as UTF-8 text. */
export async function readBodyText(
  request: Request,
  { maxBytes = MAX_JSON_BODY_BYTES }: { maxBytes?: number } = {}
): Promise<ReadBodyTextResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  let text = "";
  try {
    if (request.body) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, reason: "too_large" };
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }
  } catch {
    return { ok: false, reason: "read_error" };
  }
  return { ok: true, text };
}

export async function readJsonBody(
  request: Request,
  opts: { maxBytes?: number } = {}
): Promise<ReadJsonBodyResult> {
  const read = await readBodyText(request, opts);
  if (!read.ok) {
    return { ok: false, reason: read.reason === "too_large" ? "too_large" : "invalid_json" };
  }
  try {
    return { ok: true, body: JSON.parse(read.text) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
