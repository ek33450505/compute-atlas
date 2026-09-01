import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Prose-spacing guard — catches words silently joined together in rendered
// prose, e.g. "tracks 79dedicated-generation projects".
// ---------------------------------------------------------------------------
//
// Root cause (found 2026-08-27, app/power/page.tsx, app/explore/page.tsx,
// app/stats/page.tsx): when a JSX text chunk follows an interpolation
// `{...}` AND that chunk contains an HTML entity (`&apos;`, `&rsquo;`,
// `&middot;`, ...), the chunk's leading space is silently dropped at render
// time. The source looks correct (a normal space character survives
// `od -c`), so this is invisible in code review — it only shows up in the
// rendered HTML, where React's `<!-- -->` text-node separator sits directly
// between two word characters with no space in between:
//
//   broken:  tracks <!-- -->79<!-- -->dedicated-generation
//   fixed:   tracks <!-- -->79<!-- --> <!-- -->dedicated-generation
//
// Fixed at the 3 known sites by inserting an explicit `{" "}` immediately
// after the interpolation (matching the pattern already used elsewhere in
// app/power/page.tsx, e.g. `total{" "}` / `{buildout.gas.total}{" "}`).
// This spec fetches raw SSR HTML (not a hydrated DOM) for a small set of
// routes and fails if the joined-word symptom reappears on any of them —
// here, or anywhere else on these pages.

// Static routes, plus ONE representative of each dynamic template. The
// dynamic ones matter most: the densest entity-bearing prose lives in
// components/facility/{civic-impact,siting-context,provenance-panel}.tsx,
// which render on ~1,000 generated pages that a static-route-only list would
// never load. A regression there would be invisible here but visible to
// every reader of every facility page. Slugs match the ones the sibling
// specs already resolve (e2e/facility.spec.ts).
const ROUTES = [
  "/",
  "/power",
  "/explore",
  "/stats",
  "/about",
  "/contact",
  "/facilities/meta-prineville-or",
  "/states/texas",
  "/operators/google",
  "/learn/data-center-water-use",
  // Added 2026-08-31: both pages carry the entity-after-interpolation shape
  // that shipped the original bug — an interpolation followed by a text chunk
  // containing `&middot;`. Verified sites at the time of writing:
  //   app/rankings/page.tsx:230,:283,:299 — `tracked{" "}` then a chunk
  //     beginning `&middot; {disclosedCount}` (operator row + two state rows)
  //   app/rankings/page.tsx:176 and app/crypto/page.tsx:161 —
  //     `{f.operator} &middot; {formatLocation(f)}`
  // Both routes are here for those MIDDOT sites, which JOINED_ENTITY_PATTERN
  // below is what guards.
  //
  // ⚠️ Do NOT re-justify these routes by pointing at `Atlas&apos;s`
  // (app/crypto/page.tsx:111). An earlier version of this comment did, and it
  // was wrong twice over: `&apos;` is deliberately excluded from the entity
  // pattern, AND that apostrophe sits in static prose with no interpolation
  // before it, so the bug cannot occur there in the first place. The bug needs
  // a text chunk that FOLLOWS an interpolation; static prose is never at risk.
  "/rankings",
  "/crypto",
] as const;

// A word/digit character, then React's SSR text-node separator, then the
// start of a real word. The `[a-zA-Z-]{2,}` tail (3+ letters/hyphens total)
// is deliberate: it excludes legitimate adjacency such as a number directly
// followed by a unit suffix or a lone pluralizing "s" — those are one
// character, not a whole word, so they don't match.
const SEPARATOR = "<!-- -->";
const SENTINEL = "\u0000";
const JOINED_WORD_PATTERN = /[0-9a-zA-Z]\u0000[a-zA-Z][a-zA-Z-]{2,}/g;

// WARNING - BLIND SPOT the pattern above cannot see: it only fires when a
// LETTER follows the separator. A text chunk that BEGINS with an entity renders
// as `word·` - the character after the separator is the GLYPH, so a dropped
// space there goes undetected. Not hypothetical: /rankings carries three
// `&middot;` sites immediately after an interpolation, and /crypto one more.
//
// Correct output always keeps a real space on each side of the glyph - verified
// against rendered SSR HTML 2026-08-31:
//   Riot Platforms<!-- --> · <!-- -->Corsicana, TX
// so the separator sitting DIRECTLY against the glyph is the anomaly. The class
// below is a SINGLE glyph - the middot (&middot;) - because it is the only one
// this codebase emits where a space is always required. See the exclusions.
//
// EXCLUDED ON PURPOSE - do not add these back without evidence:
//   ' and ' (&rsquo;/&lsquo;) - a possessive is legitimately unspaced. If the
//     space before `'s` dropped, `Google's` is the CORRECT rendering, not a bug,
//     and `{operator}&rsquo;s` is natural English someone will write.
//   - (&mdash;) - legitimately unspaced in a range, e.g. `{start}-{end}`.
// The principle: this only guards glyphs where a space SHOULD be there. A
// middot used as a separator always needs its spaces; the others often must not
// have them. Including them would guarantee a false positive, and a gate that
// cries wolf gets loosened - which is how it becomes theatre.
//
// No allow-list applies here: unlike the word case there is nothing to rejoin,
// because a glyph is never half of a legitimately-split word.
//
// MUTATION-PROVEN 2026-08-31, both directions, with this final pattern:
// baseline 11 passed / exit 0; with a `{" "}` removed so an interpolation sits
// directly before a `&middot;` chunk, exit 1 with 9 offenders of the shape
// `Vistra<!-- -->·` - a shape JOINED_WORD_PATTERN structurally cannot match.
// Re-probe if the pattern changes: an earlier plant failed via the WORD pattern
// (`facilities<!-- -->tracked`) and never exercised this one at all.
const JOINED_ENTITY_PATTERN = /[0-9a-zA-Z]\u0000[·]/g;

// A separator may also legitimately sit INSIDE a single word, where a ternary
// splits it into stem + suffix — e.g.
//   {count} facilit{count === 1 ? "y" : "ies"} tracked
// in app/states/[state]/page.tsx and app/operators/[operator]/page.tsx, which
// renders correctly as "130 facilities tracked". Rejoining those halves yields
// a real word, whereas the bug yields two words jammed together
// ("79dedicated"). So we allow-list by the REJOINED word, not by route.
//
// ⚠️ Only add an entry when you have confirmed in the rendered page that the
// text reads correctly, and say why. Loosening this list to make a failure go
// away would turn the guard into theatre — the whole point is that this bug is
// invisible in source and only detectable here.
const LEGITIMATE_REJOINED_WORDS = new Set(["facility", "facilities"]);

/** Expands from a match to the whole word around it, minus separators. */
function rejoinedWordAt(marked: string, matchIndex: number): string {
  const isWordish = (c: string) => /[0-9A-Za-z\-\u0000]/.test(c);
  let start = matchIndex;
  while (start > 0 && isWordish(marked[start - 1])) start--;
  let end = matchIndex;
  while (end < marked.length && isWordish(marked[end])) end++;
  return marked.slice(start, end).split(SENTINEL).join("").replace(/-+$/, "");
}

function findJoinedWords(html: string): string[] {
  // Swap the separator for a single sentinel char so index arithmetic stays
  // simple and the pattern can't accidentally match across other markup.
  const marked = html.split(SEPARATOR).join(SENTINEL);

  const contextAround = (match: RegExpMatchArray) => {
    const start = Math.max(0, match.index! - 30);
    const end = Math.min(marked.length, match.index! + match[0].length + 30);
    const context = marked.slice(start, end).split(SENTINEL).join(SEPARATOR);
    return `...${context}...`;
  };

  const wordOffenders = [...marked.matchAll(JOINED_WORD_PATTERN)]
    .filter(
      (match) =>
        !LEGITIMATE_REJOINED_WORDS.has(
          rejoinedWordAt(marked, match.index!).toLowerCase()
        )
    )
    .map(contextAround);

  const entityOffenders = [...marked.matchAll(JOINED_ENTITY_PATTERN)].map(
    contextAround
  );

  return [...wordOffenders, ...entityOffenders];
}

for (const route of ROUTES) {
  test(`${route} has no words joined by a dropped JSX space`, async ({
    request,
  }) => {
    const response = await request.get(route);
    expect(response.status()).toBe(200);

    const html = await response.text();
    const offenders = findJoinedWords(html);

    expect(
      offenders,
      `found ${offenders.length} joined-word symptom(s) on ${route}:\n${offenders.join("\n")}`
    ).toHaveLength(0);
  });
}
