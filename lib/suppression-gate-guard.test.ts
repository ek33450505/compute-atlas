// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * `SuppressionStatus` is "suppressed" | "clear" | "unknown", all truthy, and
 * `status !== "suppressed"` fails OPEN on "unknown". The only sanctioned
 * gates are `mayEmail(status)` and an exhaustive switch inside
 * lib/suppressions.ts. This guard parses (TypeScript AST, not a regex)
 * every production file that imports lib/suppressions and fails if one
 * compares anything to "suppressed" or "unknown", by operator or `case`.
 */

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report"]);
const OWNER = join("lib", "suppressions.ts");
const FORBIDDEN = new Set(["suppressed", "unknown"]);
const COMPARISON_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Strips parentheses, `as`, `satisfies`, `<T>x` and `x!` wrappers. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function isForbiddenLiteral(node: ts.Expression): boolean {
  const n = unwrap(node);
  return (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && FORBIDDEN.has(n.text);
}

const MEMBERSHIP_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "has", "some", "find", "findIndex"]);

/**
 * Line numbers where `source` gates on a suppression status literal: the
 * literal (or a variable initialised from it) as an operand of ==, ===, !=,
 * !==, a `case`, or a membership call (`[..].includes(x)`, `x.includes(..)`).
 * Parentheses and `as`/`satisfies` wrappers are looked through.
 */
function findStatusComparisons(source: string, fileName = "x.ts"): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits = new Set<number>();
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // Pass 1: names bound to a forbidden literal, so `status === s` is caught.
  const tainted = new Set<string>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isForbiddenLiteral(node.initializer)
    ) {
      tainted.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const isForbidden = (e: ts.Expression): boolean => {
    if (isForbiddenLiteral(e)) return true;
    const u = unwrap(e);
    return ts.isIdentifier(u) && tainted.has(u.text);
  };
  const isForbiddenArray = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    return ts.isArrayLiteralExpression(u) && u.elements.some((el) => isForbidden(el));
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      COMPARISON_OPS.has(node.operatorToken.kind) &&
      (isForbidden(node.left) || isForbidden(node.right))
    ) {
      hits.add(line(node));
    } else if (ts.isCaseClause(node) && isForbidden(node.expression)) {
      hits.add(line(node));
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MEMBERSHIP_METHODS.has(node.expression.name.text) &&
      (isForbiddenArray(node.expression.expression) || node.arguments.some((a) => isForbidden(a)))
    ) {
      hits.add(line(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...hits];
}

function importsSuppressions(source: string): boolean {
  return /from\s+["']@\/lib\/suppressions["']|from\s+["'](\.\/|\.\.\/)+(lib\/)?suppressions["']/.test(source);
}

function* productionFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* productionFiles(join(dir, entry.name));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

describe("suppression status gate guard", () => {
  it("no production caller gates on 'suppressed' or 'unknown' (use mayEmail)", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of productionFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === OWNER) continue;
      const source = readFileSync(file, "utf-8");
      if (!importsSuppressions(source)) continue;
      scanned++;
      for (const l of findStatusComparisons(source, rel)) offenders.push(`${rel}:${l}`);
    }
    // Non-vacuity: subscribe.ts and others import the module, so 0 would mean the scan found nothing.
    expect(scanned).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });

  describe("detector (mutation fixtures)", () => {
    it.each([
      ['if (status !== "suppressed") send();'],
      ['if (status === "unknown") return;'],
      ['if ("suppressed" == status) return;'],
      ['switch (status) { case "suppressed": break; }'],
      ["const bad = status != `unknown`;"],
      ['const s = "suppressed"; if (status === s) return;'],
      ['if ((status) === ("suppressed")) return;'],
      ['if (status === ("unknown" as const)) return;'],
      ['if (status === ("unknown" satisfies string)) return;'],
      ['if (["suppressed", "unknown"].includes(status)) return;'],
      ['if (names.includes("suppressed")) return;'],
    ])("flags %s", (code) => {
      expect(findStatusComparisons(code)).toHaveLength(1);
    });

    it.each([
      ["if (mayEmail(status)) send();"],
      ['const label = "suppressed";'],
      ['if (kind === "global") return;'],
      ['const s = "suppressed"; log(s);'],
      ['if (["a", "b"].includes(kind)) return;'],
    ])("does not flag %s", (code) => {
      expect(findStatusComparisons(code)).toHaveLength(0);
    });
  });
});
