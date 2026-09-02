// Parity test between the bench's HTML-to-text extractor (html.mjs, JS) and
// the shipped pipeline's `htmlToText` (../fetch-page-text.ts, TS).
//
// WHY THIS EXISTS: the bench's `fetch-pages.mjs` used to inline its own
// stripped-down stripping chain (tags stripped, only `&nbsp;` decoded) instead
// of calling a copy of the real `htmlToText`. Measured on the 69-page cached
// corpus (scripts/discovery/bench/pages.json): 65 pages (94%) carry at least
// one HTML entity the shipped extractor decodes and the old bench chain left
// raw — `&amp;` (622 occurrences / 54 pages), `&#NNN;` (1912 / 40 pages),
// `&lt;`/`&gt;` (232 each / 5 pages), `&quot;` (54 / 10 pages), `&#39;` (4 / 4
// pages). So the bench's headline PRECISION/RECALL numbers were measured
// against text materially unlike what production feeds the model — even
// though a full re-check of every real model quote in every result file
// found 0 verdict flips from decoding (the numbers themselves were not
// invalidated; the corpus fidelity gap was still real and unguarded).
// This test is what makes the now-shared `htmlToText` logic safe to
// duplicate — run it whenever either file changes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { htmlToText as htmlToTextJs } from "./html.mjs";
import { htmlToText as htmlToTextTs } from "../fetch-page-text";

// process.cwd() (the repo root Vitest runs from), not import.meta.url — see
// quote-parity.test.ts's identical note.
const BENCH_DIR = path.resolve(process.cwd(), "scripts/discovery/bench");

describe("curated edge cases: both implementations agree", () => {
  it("strips <script> WITH its contents", () => {
    const html = "<p>before</p><script>var x = 1; document.write('<b>evil</b>');</script><p>after</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("before after");
  });

  it("strips <style> WITH its contents, including whitespace before the end tag's `>`", () => {
    const html = "<p>before</p><style>.a{color:red}</style\t>\n<p>after</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("before after");
  });

  it("strips a script tag whose end tag carries stray junk (`</script\\t\\n bar>`)", () => {
    const html = "<p>before</p><script>var x = 1;</script\t\n bar><p>after</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("before after");
  });

  it("decodes every named entity: &amp; &lt; &gt; &quot; &#39; &nbsp;", () => {
    const html = "<p>Tom &amp; Jerry say &quot;hi&quot; &lt;here&gt; it&#39;s&nbsp;fine</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe('Tom & Jerry say "hi" <here> it\'s fine');
  });

  it("decodes decimal numeric entities (&#160; nbsp, &#8217; right single quote, &#8211; en dash)", () => {
    const html = "campus&#8217;s press kit &#8211; scope: 540&#160;MW";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe(
      "campus" + String.fromCharCode(8217) + "s press kit " + String.fromCharCode(8211) + " scope: 540 MW"
    );
  });

  it("strips tags BEFORE decoding entities — an escaped &lt;p&gt; in prose survives as literal text, never as a tag delimiter", () => {
    const html = "<p>The manual says to write &lt;p&gt;paragraph&lt;/p&gt; in your markup.</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("The manual says to write <p>paragraph</p> in your markup.");
  });

  it("collapses whitespace runs (newlines, tabs, repeated spaces) to a single space and trims", () => {
    const html = "\n\n<div>\t\tfirst  \n\n  second\t</div>   ";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("first second");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToTextJs("")).toBe(htmlToTextTs(""));
    expect(htmlToTextJs("")).toBe("");
  });

  it("returns an empty string for input that is only tags/whitespace", () => {
    const html = "  <div>\n\t</div>  ";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("");
  });

  it("leaves an unrecognized numeric-looking entity form (&#xNNN; hex) undecoded on both sides", () => {
    const html = "value &#x2013; here";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("value &#x2013; here");
  });

  it("leaves a bare `<>` as literal text — the tag regex requires at least one character between the brackets, so `<>` is not a tag on either side", () => {
    const html = "<p>before</p> <> <p>after</p>";
    expect(htmlToTextJs(html)).toBe(htmlToTextTs(html));
    expect(htmlToTextJs(html)).toBe("before <> after");
  });
});

// ============================================================================
// Real corpus: pages.json holds text that is ALREADY extracted (not raw
// HTML) — most cached pages carry no leftover markup at all, since fetching
// runs the (old, un-decoded) extractor before caching. So this is NOT a
// "re-extract from HTML" check; it feeds the cached text through both
// implementations AS INPUT and asserts equal OUTPUT — an idempotence/parity
// check. It stays meaningful because the cached text still carries raw HTML
// entities the old bench chain never decoded (see this file's header), so a
// real difference in entity handling still surfaces here even though the
// input isn't raw markup.
// ============================================================================
interface PageEntry {
  facilityId: string;
  text: string;
}
const pagesFile = JSON.parse(
  readFileSync(path.join(BENCH_DIR, "pages.json"), "utf8")
) as PageEntry[];

// Canary: an empty corpus would make the loop below vacuous — it would pass
// trivially while testing nothing (same shape as quote-parity.test.ts's
// "loaded a meaningful number of real triples" canary).
it("loaded a meaningful number of real cached pages from the bench corpus", () => {
  expect(pagesFile.length).toBeGreaterThan(20);
});

describe("real corpus: html.mjs vs fetch-page-text.ts parity on every cached page's text", () => {
  for (const { facilityId, text } of pagesFile) {
    it(`${facilityId}`, () => {
      expect(htmlToTextJs(text)).toBe(htmlToTextTs(text));
    });
  }
});
