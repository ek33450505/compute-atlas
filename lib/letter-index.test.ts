import { describe, it, expect } from "vitest";

import { letterOf, parseLetter, lettersInUse, letterLabel, LETTERS, OTHER_LETTER } from "./letter-index";

describe("parseLetter", () => {
  it("accepts a-z and other, case-insensitively", () => {
    expect(parseLetter("c")).toBe("c");
    expect(parseLetter("C")).toBe("c");
    expect(parseLetter("other")).toBe("other");
  });

  it.each([undefined, "", "ab", "1", "../x", "%00", ["a", "b"], "\u212A", "ı", "ſ"])(
    "rejects %j",
    (raw) => expect(parseLetter(raw)).toBeNull()
  );
});

describe("letterOf", () => {
  it("uses the first letter, folding diacritics and case", () => {
    expect(letterOf("Acme")).toBe("a");
    expect(letterOf("émile")).toBe("e");
  });

  it("skips leading punctuation", () => {
    expect(letterOf("  (Zeta) Corp")).toBe("z");
  });

  it("buckets digits, symbols and non-Latin names as other", () => {
    expect(letterOf("11:11 Systems")).toBe("other");
    expect(letterOf("123Net")).toBe("other");
    expect(letterOf("日本")).toBe("other");
    expect(letterOf("")).toBe("other");
  });

  it("places every name in a bucket that parseLetter accepts", () => {
    for (const n of ["Acme", "9Net", "Ünal", "--"]) {
      expect(LETTERS).toContain(letterOf(n));
    }
  });
});

describe("lettersInUse / letterLabel", () => {
  it("collects the buckets in use", () => {
    expect([...lettersInUse(["Acme", "Apex", "9Net"])].sort()).toEqual(["a", "other"]);
  });
  it("labels buckets", () => {
    expect(letterLabel("c")).toBe("C");
    expect(letterLabel("other")).toBe("0–9 & other");
  });
});

describe("letter sub-views cover every name", () => {
  // Non-ASCII first letters, a digit, punctuation and a diacritic that folds.
  const names = ["Alpha", "Émile Co", "Øresund Ltd", "Łukasz", "3M", "(Acme)", "Zed", "  "];

  it("each name lands in exactly one linked letter and the groups partition the list", () => {
    const used = lettersInUse(names);
    let covered = 0;
    for (const letter of used) {
      expect(LETTERS).toContain(letter);
      covered += names.filter((n) => letterOf(n) === letter).length;
    }
    expect(covered).toBe(names.length);
    expect(letterOf("Øresund Ltd")).toBe(OTHER_LETTER);
    expect(letterOf("3M")).toBe(OTHER_LETTER);
    expect(letterOf("Émile Co")).toBe("e");
  });
});
