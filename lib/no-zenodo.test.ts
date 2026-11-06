import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Zenodo records are gone, so nothing the site ships may cite or link
 * them. Scans source (not tests) under app/, components/, lib/ plus
 * public/llms.txt.
 */
const ROOT = process.cwd();
const PATTERN = /zenodo|10\.5281/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|mdx?|json|txt)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("no Zenodo / DOI references", () => {
  it("appears in no shipped source file", () => {
    const files = [
      ...["app", "components", "lib"].flatMap((d) => walk(path.join(ROOT, d))),
      path.join(ROOT, "public/llms.txt"),
    ];
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => PATTERN.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
