// HTML-to-text extraction for the bench — a hand-ported copy of the shipped
// pipeline's `htmlToText` (scripts/discovery/fetch-page-text.ts). Bench
// scripts run under plain `node` (see bench/README.md), so a `.mjs` cannot
// import the TS original; this is the bench's own copy of that logic, the
// same duplication pattern quote.mjs uses for the quote-grounding gate (see
// that file's header). `html-parity.test.ts` is what keeps the two in step —
// run it after touching either this file or fetch-page-text.ts.
//
// `<\/\1\b[^>]*>` not `<\/\1>`: HTML parsers tolerate whitespace AND stray
// junk inside an end tag, so `</script >` and even `</script\t\n bar>` are
// treated as end tags while a strict `</script>` misses them and the script
// body survives into the "plain text". Flagged by CodeQL (js/bad-tag-filter)
// on the bench's OWN copy of this regex, PR #158; fixed in both so the two
// stay in step. (fetch-pages.mjs used to carry an un-backreferenced pair of
// script/style regexes with this same flaw — see the comment this file's
// wiring replaces.)
const SCRIPT_OR_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

// The common named entities this dependency-free extractor decodes. Decimal
// numeric entities (`&#NNN;`) are handled separately below; hex numeric
// entities (`&#xNNN;`) are out of scope, mirroring fetch-page-text.ts's v1.
const NAMED_ENTITY_RE = /&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g;
const NAMED_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(input) {
  const named = input.replace(NAMED_ENTITY_RE, (match) => NAMED_ENTITIES[match]);
  return named.replace(/&#(\d+);/g, (match, code) => {
    const codepoint = Number(code);
    return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : match;
  });
}

/**
 * Strips HTML down to plain text: drops `<script>`/`<style>` elements
 * (including their contents), strips all remaining tags, decodes the common
 * HTML entities, and collapses whitespace runs. Order matters: tags are
 * stripped BEFORE entities are decoded, so a literal, escaped "&lt;" in page
 * prose can never be mistaken for a real tag delimiter. Must stay
 * byte-for-byte identical to fetch-page-text.ts's `htmlToText` — that is what
 * html-parity.test.ts asserts.
 */
export function htmlToText(html) {
  const withoutScriptsAndStyles = html.replace(SCRIPT_OR_STYLE_RE, " ");
  const withoutTags = withoutScriptsAndStyles.replace(TAG_RE, " ");
  const decoded = decodeEntities(withoutTags);
  return decoded.replace(WHITESPACE_RE, " ").trim();
}
