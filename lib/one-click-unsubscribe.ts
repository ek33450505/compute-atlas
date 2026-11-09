/** A slow or stalled body is not a one-click: give up reading after this long. */
export const ONE_CLICK_READ_TIMEOUT_MS = 2000;

/** RFC 8058: the entire body a one-click client sends. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/**
 * True iff the POST body is exactly the RFC 8058 one-click marker. Reads at
 * most a few bytes past the marker's length and never throws: anything longer,
 * unreadable or different is simply "not one-click" (a page form posts an
 * empty body).
 */
export async function isOneClickUnsubscribe(request: Request): Promise<boolean> {
  const limit = ONE_CLICK_BODY.length + 1;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > ONE_CLICK_BODY.length) {
    return false;
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return false;
  }
  const read = async (): Promise<boolean> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total > ONE_CLICK_BODY.length) {
      return false;
    }
    return new TextDecoder().decode(Buffer.concat(chunks)) === ONE_CLICK_BODY;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A stalled body (slowloris) must not hold the handler: after the timeout
    // it is simply not a one-click.
    return await Promise.race([
      read(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ONE_CLICK_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}
