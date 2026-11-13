import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmapCodePoints } from "./font-cmap";
import { OG_REPLACEMENTS, loadCoveredSet, toOgText, truncateOgText } from "./og-text";

describe("toOgText", () => {
  it.each([
    ["Lightboard ★ Vermont (530 Community Drive carrier hotel)", "Lightboard · Vermont (530 Community Drive carrier hotel)"],
    ["Google Cable Landing Station at UH West Oʻahu", "Google Cable Landing Station at UH West O‘ahu"],
    ["University of Hawaiʻi (Information Technology Services)", "University of Hawai‘i (Information Technology Services)"],
    ["DāSTOR Wilmington", "DāSTOR Wilmington"],
    ["Kalanimōkū Building", "Kalanimōkū Building"],
  ])("maps %s", (input, expected) => {
    expect(toOgText(input)).toBe(expected);
  });

  it("passes covered characters through unchanged", () => {
    const s = "Plain · name – 12° … ‘quoted’";
    expect(toOgText(s)).toBe(s);
  });

  it("collapses whitespace left by a removed or doubled separator", () => {
    expect(toOgText("  A   B \n C  ")).toBe("A B C");
  });
});

describe("toOgText generic fallback", () => {
  it("drops an uncovered glyph and collapses the gap", () => {
    expect(toOgText("Snow ☃ Man")).toBe("Snow Man");
    expect(toOgText("Snow☃Man")).toBe("SnowMan");
  });

  it("keeps the covered base of a decomposable uncovered character", () => {
    // U+FF21 (fullwidth A) is not in Fraunces' cmap; NFKD gives "A".
    expect(toOgText("ＡBC ①")).toBe("ABC 1");
  });

  it("leaves covered text unchanged", () => {
    expect(toOgText("Kalanimōkū · DāSTOR 12° …")).toBe("Kalanimōkū · DāSTOR 12° …");
  });

  it("falls back to the explicit map when the cmap cannot be read", () => {
    expect(loadCoveredSet(() => Buffer.from("not a font"))).toBeNull();
    expect(loadCoveredSet(() => { throw new Error("ENOENT"); })).toBeNull();
    expect(toOgText("A ★ Oʻahu ☃", null)).toBe("A · O\u2018ahu ☃");
  });
});

describe("OG font coverage", () => {
  const font = cmapCodePoints(readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf")));

  it("contains every character a replacement can emit", () => {
    for (const to of Object.values(OG_REPLACEMENTS)) {
      for (const ch of to) expect(font.has(ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
    }
  });

  it("lacks every character that is replaced (a covered one needs no entry)", () => {
    for (const from of Object.keys(OG_REPLACEMENTS)) {
      expect(font.has(from.codePointAt(0)!), `U+${from.codePointAt(0)!.toString(16)}`).toBe(false);
    }
  });
});

/** Build a minimal TTF holding one cmap subtable (pid 3, eid 1 or 10). */
function fakeFont(eid: number, subtable: Buffer): Buffer {
  const head = Buffer.alloc(12 + 16);
  head.writeUInt16BE(1, 4);
  head.write("cmap", 12, "latin1");
  head.writeUInt32BE(28, 20);
  const cmapHdr = Buffer.alloc(12);
  cmapHdr.writeUInt16BE(1, 2);
  cmapHdr.writeUInt16BE(3, 4);
  cmapHdr.writeUInt16BE(eid, 6);
  cmapHdr.writeUInt32BE(12, 8);
  return Buffer.concat([head, cmapHdr, subtable]);
}

describe("real font coverage", () => {
  const font = cmapCodePoints(readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf")));
  it("covers ASCII letters and macron vowels", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzĀĪŌŪāīōū") {
      expect(font.has(ch.codePointAt(0)!), ch).toBe(true);
    }
  });
});

describe("cmap reader on malformed input", () => {
  it("returns null for garbage and truncated data without throwing", () => {
    expect(loadCoveredSet(() => Buffer.from("garbage bytes that are no font at all"))).toBeNull();
    const real = readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf"));
    expect(loadCoveredSet(() => real.subarray(0, 40))).toBeNull();
  });

  it("bounds an oversized format-12 group", () => {
    const sub = Buffer.alloc(16 + 12);
    sub.writeUInt16BE(12, 0);
    sub.writeUInt32BE(1, 12);
    sub.writeUInt32BE(0, 16);
    sub.writeUInt32BE(0xffffffff, 20);
    const set = loadCoveredSet(() => fakeFont(10, sub));
    expect(set).not.toBeNull();
    expect(set!.size).toBeLessThanOrEqual(0x110000);
    expect(set!.has(0x110000)).toBe(false);
  });

  it("does not count a format-4 mapping to glyph 0 as coverage", () => {
    // Two segments: [0x41,0x42] delta 0 -> glyphs 0x41/0x42 (covered);
    // [0x43,0x43] delta -0x43 -> glyph 0 (.notdef, not covered); plus terminal 0xFFFF.
    const segs = 3;
    const sub = Buffer.alloc(16 + segs * 8);
    sub.writeUInt16BE(4, 0);
    sub.writeUInt16BE(segs * 2, 6);
    const ends = [0x42, 0x43, 0xffff];
    const starts = [0x41, 0x43, 0xffff];
    const deltas = [0, (-0x43) & 0xffff, 1];
    for (let i = 0; i < segs; i++) {
      sub.writeUInt16BE(ends[i], 14 + i * 2);
      sub.writeUInt16BE(starts[i], 16 + segs * 2 + i * 2);
      sub.writeUInt16BE(deltas[i], 16 + segs * 4 + i * 2);
    }
    const set = loadCoveredSet(() => fakeFont(1, sub));
    expect(set).not.toBeNull();
    expect(set!.has(0x41)).toBe(true);
    expect(set!.has(0x42)).toBe(true);
    expect(set!.has(0x43)).toBe(false);
  });
});

describe("cmap format 4 with a non-zero idRangeOffset", () => {
  it("applies idDelta to the looked-up glyph id", () => {
    // Segment [0x41,0x42] (idRangeOffset 4 -> glyph array) delta 5, plus terminal.
    // U+0041 looks up glyph 10 -> 15 (covered); U+0042 looks up 0xFFFB -> 0 (not covered).
    const segs = 2;
    const sub = Buffer.alloc(16 + segs * 8 + 4);
    sub.writeUInt16BE(4, 0);
    sub.writeUInt16BE(segs * 2, 6);
    sub.writeUInt16BE(0x42, 14);
    sub.writeUInt16BE(0xffff, 16);
    sub.writeUInt16BE(0x41, 16 + segs * 2);
    sub.writeUInt16BE(0xffff, 18 + segs * 2);
    sub.writeUInt16BE(5, 16 + segs * 4);
    sub.writeUInt16BE(1, 18 + segs * 4);
    sub.writeUInt16BE(4, 16 + segs * 6);
    sub.writeUInt16BE(0, 18 + segs * 6);
    sub.writeUInt16BE(10, 16 + segs * 8);
    sub.writeUInt16BE(0xfffb, 18 + segs * 8);
    const set = loadCoveredSet(() => fakeFont(1, sub));
    expect(set).not.toBeNull();
    expect(set!.has(0x41)).toBe(true);
    expect(set!.has(0x42)).toBe(false);
  });
});

describe("truncateOgText", () => {
  it("never emits a lone surrogate", () => {
    const out = truncateOgText("😀".repeat(10), 4);
    expect(out).toBe("😀😀😀…");
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
  it("leaves short text alone", () => {
    expect(truncateOgText("short", 52)).toBe("short");
  });
});
