// Pins the bench's plain-node copy of decodeEntities (scripts/discovery/bench/html.mjs)
// to the shipped TS leaf. A .mjs cannot import the TS original, so the two are
// duplicated and this corpus is what keeps them byte-identical.
import { describe, it, expect } from "vitest";

import { decodeEntities as decodeTs } from "./html-entities";
import { decodeEntities as decodeMjs } from "../scripts/discovery/bench/html.mjs";

const CORPUS = [
  "&#0;",
  "&#55296;",
  "&#56320;",
  "&#1114111;",
  "&#1114112;",
  "&#99999999999999999999;",
  "&#x41;",
  "&#X1F600;",
  "&#xD800;",
  "&#x110000;",
  "&#xFFFFFFFFFFFF;",
  "&amp;#65;",
  "&amp;amp;",
  "a&nbsp;b",
  "&#39;",
  "&lt;b&gt; &quot;q&quot; &#65;&#x42;",
  "&#x0;",
  "&#x;",
  "&#;",
  "&#" + "9".repeat(400) + ";",
  "&#x" + "F".repeat(400) + ";",
  "plain text",
  "",
  // ~100 KB of repeated entity soup.
  "&amp;#65; &#x1F600;&#0;&#xD800;&lt;&#99999999999;&nbsp;&#x;&#;&bogus;&#39; ".repeat(1400),
];

// Long inputs get a short label so the test title stays readable.
function label(input: string): string {
  if (input.length <= 60) return JSON.stringify(input);
  return `${JSON.stringify(input.slice(0, 30))}... (${input.length} chars)`;
}

describe("decodeEntities drift (TS leaf vs bench html.mjs)", () => {
  it.each(CORPUS.map((input) => [label(input), input]))("agrees on %s", (_label, input) => {
    let ts: string | undefined;
    let mjs: string | undefined;
    expect(() => {
      ts = decodeTs(input);
    }).not.toThrow();
    expect(() => {
      mjs = decodeMjs(input);
    }).not.toThrow();
    expect(mjs).toBe(ts);
  });
});
