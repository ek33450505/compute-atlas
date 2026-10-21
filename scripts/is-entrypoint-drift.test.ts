import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Plain-node `.mjs` scripts cannot import `scripts/is-entrypoint.ts`, so six
 * of them inline a copy of `isEntrypoint`. This pins each copy to the shared
 * helper by comparing the AST (comments stripped, printed canonically), so a
 * copy that drops `realpathSync`, swaps `===` for `==`, or loses the catch
 * fails here. A source regex would pass on any of those that kept the words.
 *
 * Allowed differences, each asserted narrowly before it is applied:
 *   1. The TS helper takes `(importMetaUrl, argv1 = process.argv[1])`; copies
 *      take no parameters and read `import.meta.url` / `process.argv[1]`
 *      directly. Applied by substituting those two identifiers.
 *   2. The TS helper's leading `if (argv1 === undefined) return false;`. A
 *      copy omits it: `realpathSync(undefined)` throws and the catch returns
 *      false, so behavior is identical.
 */

const repoRoot = resolve(__dirname, "..");

const COPIES = [
  "scripts/build-hero-plate.mjs",
  "scripts/build-hero-points.mjs",
  "scripts/build-map-data.mjs",
  "scripts/build-pipeline-history.mjs",
  "scripts/check-siting-additive.mjs",
  "scripts/lint-no-raw-error-logs.mjs",
];

const printer = ts.createPrinter({ removeComments: true });

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
}

function print(node: ts.Node, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sf);
}

function containsCall(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function containsMatch(node: ts.Node, pred: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (pred(n)) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const isImportMetaUrl = (n: ts.Node) =>
  ts.isPropertyAccessExpression(n) &&
  n.name.text === "url" &&
  ts.isMetaProperty(n.expression);

const isProcessArgv1 = (n: ts.Node) =>
  ts.isElementAccessExpression(n) &&
  ts.isPropertyAccessExpression(n.expression) &&
  n.expression.name.text === "argv" &&
  ts.isIdentifier(n.expression.expression) &&
  n.expression.expression.text === "process" &&
  ts.isNumericLiteral(n.argumentExpression) &&
  n.argumentExpression.text === "1";

interface FnLike {
  name: string;
  params: readonly ts.ParameterDeclaration[];
  body: ts.ConciseBody;
}

/** Top-level `function f() {}` and `const f = () => {}` / `= function () {}`. */
function topLevelFunctions(sf: ts.SourceFile): FnLike[] {
  const out: FnLike[] = [];
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.body) {
      out.push({ name: s.name?.text ?? "<anonymous>", params: s.parameters, body: s.body });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const init = d.initializer;
        if (
          init &&
          ts.isIdentifier(d.name) &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.push({ name: d.name.text, params: init.parameters, body: init.body });
        }
      }
    }
  }
  return out;
}

/**
 * Functions that look like an inlined entrypoint check: they combine
 * `realpathSync` with `pathToFileURL` OR `fileURLToPath`; it does NOT
 * require `import.meta.url`, so a parameterized copy is still caught. Deliberately broad, so a variant cannot hide from the
 * completeness guard.
 */
function findEntrypointCandidates(text: string, fileName = "x.mjs"): string[] {
  const sf = parse(text, fileName);
  return topLevelFunctions(sf)
    .filter(
      (f) =>
        containsCall(f.body, "realpathSync") &&
        (containsCall(f.body, "pathToFileURL") || containsCall(f.body, "fileURLToPath")),
    )
    .map((f) => f.name);
}

/**
 * The one top-level function that reads both `import.meta.url` and
 * `process.argv[1]`, whatever it is named. Located WITHOUT requiring
 * `realpathSync`, so a copy that drops it is reported by the comparison, not by
 * a lookup failure.
 */
function findEntrypointFn(sf: ts.SourceFile): FnLike {
  const matches = topLevelFunctions(sf).filter(
    (f) => containsMatch(f.body, isImportMetaUrl) && containsMatch(f.body, isProcessArgv1),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${sf.fileName}: expected exactly 1 top-level function reading import.meta.url and process.argv[1], found ${matches.length}`,
    );
  }
  return matches[0];
}

/** Canonical body of the shared helper, rewritten into the copies' parameterless shape. */
function canonicalFromShared(): string {
  const src = readFileSync(resolve(repoRoot, "scripts/is-entrypoint.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const sf = parse(js, "is-entrypoint.js");
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === "isEntrypoint",
  );
  if (!fn?.body) throw new Error("scripts/is-entrypoint.ts: isEntrypoint not found");

  // Allowance 1: the exact parameter list.
  const params = fn.parameters.map((p) => print(p, sf));
  expect(params).toEqual(["importMetaUrl", "argv1 = process.argv[1]"]);

  // Allowance 2: the exact leading guard.
  const [guard, ...rest] = fn.body.statements;
  expect(print(guard, sf)).toBe("if (argv1 === undefined)\n    return false;");

  const subst: ts.TransformerFactory<ts.Node> = (ctx) => {
    const visit = (n: ts.Node): ts.Node => {
      if (ts.isIdentifier(n) && n.text === "importMetaUrl") {
        return ts.factory.createPropertyAccessExpression(
          ts.factory.createMetaProperty(
            ts.SyntaxKind.ImportKeyword,
            ts.factory.createIdentifier("meta"),
          ),
          "url",
        );
      }
      if (ts.isIdentifier(n) && n.text === "argv1") {
        return ts.factory.createElementAccessExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier("process"),
            "argv",
          ),
          ts.factory.createNumericLiteral(1),
        );
      }
      return ts.visitEachChild(n, visit, ctx);
    };
    return (root) => ts.visitNode(root, visit) as ts.Node;
  };
  const body = ts.factory.createBlock(rest, true);
  const result = ts.transform(body, [subst]);
  const out = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], sf);
  result.dispose();
  return out;
}

function canonicalFromCopy(text: string, fileName: string): string {
  const sf = parse(text, fileName);
  const fn = findEntrypointFn(sf);
  expect(fn.params.length, `${fileName}: copy must take no parameters`).toBe(0);
  expect(ts.isBlock(fn.body), `${fileName}: copy must have a block body`).toBe(true);
  return normalize(print(fn.body, sf));
}

function normalize(printed: string): string {
  const sf = parse(`function f() ${printed}`, "n.js");
  return print((sf.statements[0] as ts.FunctionDeclaration).body!, sf);
}

describe("inline isEntrypoint copies match scripts/is-entrypoint.ts", () => {
  const shared = normalize(canonicalFromShared());

  it("the canonical shared body is non-trivial", () => {
    expect(shared).toContain("realpathSync");
    expect(shared).toContain("pathToFileURL");
    expect(shared).toContain("catch");
  });

  for (const rel of COPIES) {
    it(`${rel} has not drifted`, () => {
      const text = readFileSync(resolve(repoRoot, rel), "utf8");
      expect(canonicalFromCopy(text, rel), `${rel} drifted from scripts/is-entrypoint.ts`).toBe(
        shared,
      );
    });
  }

  describe("mutants fail on the COMPARISON, not on lookup", () => {
    const BASE = `import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// see scripts/is-entrypoint.ts
function isEntrypoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
`;
    it("the unmutated fixture matches", () => {
      expect(canonicalFromCopy(BASE, "base.mjs")).toBe(shared);
    });

    const mutants: Record<string, [string, string]> = {
      "drops realpathSync": ["pathToFileURL(realpathSync(process.argv[1]))", "pathToFileURL(process.argv[1])"],
      "loosens === to ==": ["import.meta.url ===", "import.meta.url =="],
      "catch returns true": ["return false;", "return true;"],
      "drops .href": [").href;", ");"],
      "swallows the catch into a no-op": ["return false;", ""],
    };
    for (const [name, [from, to]] of Object.entries(mutants)) {
      it(`a copy that ${name} differs from the shared body`, () => {
        const mutant = BASE.replace(from, to);
        expect(mutant).not.toBe(BASE); // the replacement must have applied
        const diags = parse(mutant, "mutant.mjs") as ts.SourceFile & {
          parseDiagnostics: readonly ts.Diagnostic[];
        };
        expect(diags.parseDiagnostics, "mutant must be valid JS").toEqual([]);
        let canon: string | undefined;
        try {
          canon = canonicalFromCopy(mutant, "mutant.mjs");
        } catch (e) {
          throw new Error(`mutant "${name}" failed at lookup/parse, not comparison: ${String(e)}`);
        }
        expect(canon).not.toBe(shared);
      });
    }
  });

  describe("completeness guard", () => {
    it("detects an arrow-function copy", () => {
      const text = `const isEntrypoint = () => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
};`;
      expect(findEntrypointCandidates(text)).toEqual(["isEntrypoint"]);
    });

    it("detects a fileURLToPath variant", () => {
      const text = `function isRunDirectly() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}`;
      expect(findEntrypointCandidates(text)).toEqual(["isRunDirectly"]);
    });

    it("detects a parameterized copy that never mentions import.meta.url", () => {
      const text = `function isEntrypoint(url, argv1) {
  try { return url === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}`;
      expect(findEntrypointCandidates(text)).toEqual(["isEntrypoint"]);
    });

    it("ignores functions that merely call realpathSync", () => {
      expect(
        findEntrypointCandidates(`function f(p) { return realpathSync(p); }`),
      ).toEqual([]);
    });

    it("finds exactly COPIES across every .mjs in the repo", () => {
      const found: string[] = [];
      const skip = new Set(["node_modules", ".next", ".git", ".vercel", "coverage", "playwright-report", "test-results"]);
      const walk = (dir: string) => {
        for (const e of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
          const rel = dir === "." ? e.name : `${dir}/${e.name}`;
          if (e.isDirectory()) {
            if (!skip.has(e.name)) walk(rel);
          } else if (e.name.endsWith(".mjs")) {
            if (findEntrypointCandidates(readFileSync(resolve(repoRoot, rel), "utf8"), rel).length > 0) {
              found.push(rel);
            }
          }
        }
      };
      walk(".");
      expect(found.sort()).toEqual([...COPIES].sort());
    });
  });
});
