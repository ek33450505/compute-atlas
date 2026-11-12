import { cmapCodePoints } from "@/lib/font-cmap";
import { loadFrauncesFont } from "@/lib/og-theme";

// Fraunces-72pt-SemiBold.ttf (the only font passed to ImageResponse) has no
// glyph for some characters that appear in facility names and operators.
// Satori then fetches a fallback font per request and logs "Failed to load
// dynamic font for ★ … Status: 400" (Wave 5 item 5.5 / C-10).
//
// Measured 2026-11-12 by parsing the TTF cmap:
//   not covered: U+2605 ★, U+02BB ʻ (okina)
//   covered:     U+2018 ‘, U+0101 ā, U+014D ō, U+016B ū, U+00B7 ·, U+00B0 °, U+2026 …
// OG_REPLACEMENTS holds faithful substitutes for known glyphs. Any other
// character missing from the font's cmap goes through the generic rule in
// toOgText. Re-measure by adding a probe character to lib/og-text.test.ts.
export const OG_REPLACEMENTS: Readonly<Record<string, string>> = {
  // ʻokina -> left single quotation mark, its conventional typographic stand-in.
  "ʻ": "‘",
  // Decorative star used as a separator in one name -> middle dot.
  "★": "·",
};

/** Covered set from font bytes, or null if the font cannot be read. Never throws. */
export function loadCoveredSet(read: () => Buffer): ReadonlySet<number> | null {
  try {
    const set = cmapCodePoints(read());
    return set.size > 0 ? set : null;
  } catch {
    return null;
  }
}

// undefined = not yet loaded; null = load failed (explicit map only).
let coveredCache: ReadonlySet<number> | null | undefined;

function processCovered(): ReadonlySet<number> | null {
  if (coveredCache === undefined) coveredCache = loadCoveredSet(loadFrauncesFont);
  return coveredCache;
}

/**
 * Make text renderable with the OG font alone: explicit substitutes first,
 * then for any other uncovered character its NFKD form if every code point of
 * that is covered, else the character is dropped. Whitespace is collapsed.
 * With `covered` null (font unreadable) only the explicit map applies.
 */
export function toOgText(text: string, covered: ReadonlySet<number> | null = processCovered()): string {
  let out = "";
  for (const ch of text) {
    const mapped = OG_REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (covered === null || covered.has(cp) || /\s/.test(ch)) {
      out += ch;
      continue;
    }
    const decomposed = ch.normalize("NFKD");
    if (decomposed !== ch && [...decomposed].every((c) => covered.has(c.codePointAt(0)!))) out += decomposed;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Cut to at most `max` code points (ellipsis included), never splitting a surrogate pair. */
export function truncateOgText(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}
