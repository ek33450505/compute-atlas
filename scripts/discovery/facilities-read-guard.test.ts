// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Discovery must read the facility set only through scripts/discovery/load-facilities.ts,
 * which refuses a tiny or inconsistent snapshot. A script that reads
 * data/facilities.json itself can dedupe against the 68-record fixture or a
 * half-written file. Enforced on the AST of every .ts/.mjs file (excluding *.test.ts and *.test.mjs) under
 * scripts/discovery/ (comments are never literals, so prose that names the path
 * is fine): outside load-facilities.ts, no string literal, no-substitution
 * template, or template segment (head/middle/tail) may be, or end in a path segment named, "facilities.json"
 * (path.join(cwd, "data", "facilities.json") and `${root}/data/facilities.json`
 * both trip it).
 *
 * BOUNDARY: a tripwire for honest mistakes. A path built by concatenation
 * ("facilities" + ".json") or from non-literal pieces (a variable, an env var)
 * is out of scope and invisible to it. triage-disagreements.ts reads a
 * user-supplied `--facilities=<path>` and names no literal, so it passes.
 */

const ROOT = join(process.cwd(), "scripts", "discovery");
const OWNER = join(ROOT, "load-facilities.ts");
const TARGET = /(^|[\\/])facilities\.json$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...sourceFiles(full));
    } else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\.(ts|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function findDirectReads(source: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    const isText =
      ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    if (isText && TARGET.test(node.text)) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("facilities read guard", () => {
  it("detects a direct read and ignores comments", () => {
    const bad = 'import path from "node:path";\nreadFileSync(path.join(process.cwd(), "data", "facilities.json"));';
    const ok = '// reads data/facilities.json\n/* "data/facilities.json" */\nconst x = 1;';
    expect(findDirectReads(bad, "x.ts")).toEqual([2]);
    expect(findDirectReads("const r = 1;\nread(`${r}/data/facilities.json`);", "x.ts")).toEqual([2]);
    expect(findDirectReads("read(`/data/facilities.json`);", "x.ts")).toEqual([1]);
    expect(findDirectReads(ok, "x.ts")).toEqual([]);
  });

  it("scans a non-trivial number of files", () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(10);
  });

  it("no discovery script outside load-facilities.ts names data/facilities.json as a literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      if (file === OWNER) continue;
      for (const line of findDirectReads(readFileSync(file, "utf8"), file)) {
        offenders.push(`${relative(process.cwd(), file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
