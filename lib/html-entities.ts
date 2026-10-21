/**
 * HTML entity decoding shared by the URL triage and the discovery page fetcher.
 *
 * Pure and dependency-free: safe to import from client, server and tsx scripts.
 * `scripts/discovery/bench/html.mjs` is plain node and keeps its own copy; a
 * drift test (`lib/html-entities-drift.test.ts`) pins the two together.
 */

// The named set is exactly these five plus decimal `&#39;`; do not widen it.
const NAMED: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&nbsp;": " ",
};

// One alternation, one pass: a decoded `&` is never re-scanned, so `&amp;#65;`
// yields `&#65;` rather than `A`. `&#39;` needs no named entry: it is decimal.
const ENTITY_RE = /&amp;|&lt;|&gt;|&quot;|&nbsp;|&#(\d+);|&#[xX]([0-9a-fA-F]+);/g;

const REPLACEMENT = "�";

/** Decode a code point, mapping unstorable ones (NUL, lone surrogates, > 0x10FFFF) to U+FFFD. */
function fromCodePointSafe(codepoint: number): string {
  if (
    // Redundant with `> 0x10ffff`, kept to make the Infinity path (a 400-digit run) explicit.
    !Number.isFinite(codepoint) ||
    codepoint === 0 ||
    (codepoint >= 0xd800 && codepoint <= 0xdfff) ||
    codepoint > 0x10ffff
  ) {
    return REPLACEMENT;
  }
  return String.fromCodePoint(codepoint);
}

export function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (match, dec?: string, hex?: string) => {
    if (dec !== undefined) return fromCodePointSafe(Number.parseInt(dec, 10));
    if (hex !== undefined) return fromCodePointSafe(Number.parseInt(hex, 16));
    return NAMED[match] ?? match;
  });
}
