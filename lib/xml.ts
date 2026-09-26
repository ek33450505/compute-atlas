/**
 * Escapes a string for safe inclusion in an XML text node/attribute, and strips
 * the C0 control chars that are illegal in XML 1.0 even when entity-encoded.
 * Facility names originate from the discovery pipeline and public contributions,
 * so every dynamic value MUST pass through here — this is the feed's injection guard.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
