import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * Invariant over `app/api/**\/route.ts`: every module exports GET, and every
 * stub GET answers a no-store 405 with `Allow`.
 *
 * A route with no GET export gets Next's bare 405, which carries no cache
 * directive, so Cloudflare (cache rule: every non-/admin GET is eligible)
 * supplied `public, max-age=14400` and cached it. `methodNotAllowed`
 * (lib/api-response.ts) is `no-store` and carries `Allow`.
 *
 * Detection is by the TypeScript AST, not a regex, so comments and strings
 * cannot satisfy it and `export { GET }` / `export { x as GET }` are seen.
 */
const API_ROOT = "app/api";


const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return routeFiles(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true);
}

/** HTTP-method names the module exports, by any declaration form. */
export function exportedMethods(source: string): Set<string> {
  const found = new Set<string>();
  for (const stmt of parse(source).statements) {
    const exported = ts.canHaveModifiers(stmt)
      ? ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isFunctionDeclaration(stmt) && exported && stmt.name) {
      found.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) found.add(d.name.text);
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) found.add(el.name.text);
      }
    }
  }
  return new Set([...found].filter((n) => (METHODS as readonly string[]).includes(n)));
}

describe("exportedMethods (detector self-check)", () => {
  it("sees every export form", () => {
    expect(exportedMethods("export function GET() {}").has("GET")).toBe(true);
    expect(exportedMethods("export async function GET() {}").has("GET")).toBe(true);
    expect(exportedMethods("export const GET = () => 1;").has("GET")).toBe(true);
    expect(exportedMethods("function GET() {}\nexport { GET };").has("GET")).toBe(true);
    expect(exportedMethods("function g() {}\nexport { g as GET };").has("GET")).toBe(true);
  });

  it("does not see a missing, commented-out, string or unexported GET", () => {
    expect(exportedMethods("export function POST() {}").has("GET")).toBe(false);
    expect(exportedMethods("// export function GET() {}\nexport function POST() {}").has("GET")).toBe(false);
    expect(exportedMethods("/* export const GET = 1 */").has("GET")).toBe(false);
    expect(exportedMethods('const s = "export function GET() {}";').has("GET")).toBe(false);
    expect(exportedMethods("function GET() {}").has("GET")).toBe(false);
  });
});

describe("api route methods", () => {
  const files = routeFiles(API_ROOT);

  it("finds the route modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)("%s exports GET", (file) => {
    expect(exportedMethods(readFileSync(file, "utf8")).has("GET")).toBe(true);
  });

  /**
   * Behavioural half: a zero-arity GET takes no request, so it can only be a
   * method-not-allowed stub. Call it and check what a client (and the CDN)
   * would actually receive. Real GET handlers take a request and have their
   * own tests.
   */
  const modules = import.meta.glob<{ GET?: (...args: never[]) => Response | Promise<Response> }>(
    "./**/route.ts"
  );

  it("loads every route module", () => {
    expect(Object.keys(modules).length).toBe(files.length);
  });

  it("every zero-arity GET is a no-store 405 with Allow", async () => {
    let stubs = 0;
    for (const [path, load] of Object.entries(modules)) {
      const { GET } = await load();
      if (!GET || GET.length !== 0) continue;
      stubs += 1;
      const res = await GET();
      expect(res.status, path).toBe(405);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
      // Cloudflare evaluates CDN-Cache-Control ahead of Cache-Control.
      expect(res.headers.get("cdn-cache-control"), path).toContain("no-store");
      expect(res.headers.get("allow"), path).toMatch(/\S/);
    }
    expect(stubs).toBeGreaterThanOrEqual(8);
  });
});
