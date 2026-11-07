// @vitest-environment node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// `scripts/export.ts` is what CREATES data/*.json (the Vercel prebuild runs it before they
// exist), so nothing it loads may statically import one. A missing file there surfaces as
// MODULE_NOT_FOUND, which ensure-data-snapshot reports as "Neon export failed" and, in a
// preview, silently falls back to the 68-record fixture. Follows value imports (not
// `import type`) and dynamic `import("…")` transitively, like the facility-popup guard.
const ROOT = process.cwd();
const CODE_EXTS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"];
// The clause between `import` and `from` may hold names, braces, commas, whitespace and comments
// (which can contain quotes, e.g. `// don't`) but never a bare quote, so a side-effect
// `import "./a"` cannot be swallowed into the clause of a later `import x from "./b"`.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:(?:[\w$*{},\s]|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
// Any `import(` that is not a plain string literal cannot be followed: fail closed on it.
const NON_LITERAL_DYNAMIC_RE = /\bimport\(\s*(?!["'])/;

/** Module specifiers a source file value-imports (static, re-export and literal dynamic). */
function specifiersOf(src: string): string[] {
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]);
}

/**
 * Resolves a local/alias specifier to a path. When no candidate file exists (data/*.json on a
 * fresh clone, CI or Vercel) the base path is returned anyway, so the edge is still recorded:
 * dropping it would make this guard pass exactly when data/ is absent.
 */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  const candidates = [base, ...CODE_EXTS.map((e) => `${base}${e}`), ...CODE_EXTS.map((e) => join(base, `index${e}`))];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base;
}

/** Every local path reachable from `entry` (existing or not), as repo-relative paths. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file) || !existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    if (NON_LITERAL_DYNAMIC_RE.test(src)) {
      throw new Error(`${relative(ROOT, file)} has an import() with a non-literal argument; the guard cannot follow it`);
    }
    for (const spec of specifiersOf(src)) {
      const target = resolveLocal(spec, file);
      if (target) queue.push(target);
    }
  }
  return new Set([...seen].map((f) => relative(ROOT, f)));
}

describe("specifiersOf", () => {
  it("finds the edge after a multi-line clause with an apostrophe in a comment", () => {
    const src = 'import {\n  a, // don\'t drop this\n  b,\n} from "./g";\n';
    expect(specifiersOf(src)).toEqual(["./g"]);
  });

  it("finds both a side-effect import and a later `from` import, with or without semicolons", () => {
    expect(specifiersOf('import "./a"\nimport x from "./b"\n')).toEqual(["./a", "./b"]);
    expect(specifiersOf('import "./a";\nimport x from "./b";\n')).toEqual(["./a", "./b"]);
  });

  it("skips `import type` and finds a literal dynamic import", () => {
    expect(specifiersOf('import type { T } from "./t";\nconst m = await import("./d");\n')).toEqual(["./d"]);
  });

  it("flags a non-literal dynamic import", () => {
    expect(NON_LITERAL_DYNAMIC_RE.test("await import(`./x/${n}`)")).toBe(true);
    expect(NON_LITERAL_DYNAMIC_RE.test("await import(name)")).toBe(true);
    expect(NON_LITERAL_DYNAMIC_RE.test('await import("./x")')).toBe(false);
  });
});

describe("data-absent entry points", () => {
  it.each([
    ["scripts/export.ts", "lib/operator-ownership-schema.ts"], // direct value import (export.ts:19)
    ["scripts/ensure-data-snapshot.ts", "scripts/export.ts"], // dynamic import
  ])(
    "%s does not reach any data/ JSON through its import graph",
    (entry, knownEdge) => {
      const graph = reachable(entry);
      expect(graph.has(entry)).toBe(true);
      expect(graph.has(knownEdge)).toBe(true);
      expect(graph.size).toBeGreaterThanOrEqual(8); // non-vacuity: the walker really followed imports (measured 12-13)
      // Matches on the resolved path, so it holds whether or not data/ exists on disk.
      expect([...graph].filter((f) => f.startsWith("data/"))).toEqual([]);
    }
  );
});
