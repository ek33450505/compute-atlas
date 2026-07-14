/**
 * Returns `url` only if it uses the http or https protocol; otherwise
 * `undefined`. Guards `href` render sites against `javascript:`/`data:`/etc.
 * URLs that could execute if a write path ever bypasses schema validation.
 * A returned `undefined` makes React omit the `href` attribute entirely, so
 * the anchor renders its label text but is non-navigable.
 */
export function safeExternalHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
