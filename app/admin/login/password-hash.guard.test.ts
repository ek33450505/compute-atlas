import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * `password-hash.ts` pulls in `node:crypto` PBKDF2 for the admin password
 * check; it must never be reachable from a client bundle. Scans every
 * "use client" module under app/, components/ and lib/ for an import whose
 * specifier ends in `login/password-hash`, or `./password-hash` from within
 * app/admin/login itself.
 */
const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "lib"];
const LOGIN_DIR = join("app", "admin", "login");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LEADING_USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const SPECIFIER = /(?:from\s*|import\s*\(?\s*|require\(\s*)["']([^"']+)["']/g;

export function isUseClient(src: string): boolean {
  return LEADING_USE_CLIENT.test(src);
}

export function importsPasswordHash(src: string, fileDir: string): boolean {
  for (const m of src.matchAll(SPECIFIER)) {
    const spec = m[1];
    if (/login\/password-hash$/.test(spec)) return true;
    if (spec === "./password-hash" && fileDir === LOGIN_DIR) return true;
  }
  return false;
}

describe("password-hash import guard", () => {
  it("detector flags the shapes it must catch (so the scan cannot pass vacuously)", () => {
    expect(isUseClient('"use client";\nimport x from "y";')).toBe(true);
    expect(isUseClient("// c\n'use client'\n")).toBe(true);
    expect(isUseClient('import x from "y";\n"use client"')).toBe(false);
    expect(importsPasswordHash('import { d } from "@/app/admin/login/password-hash";', "components")).toBe(true);
    expect(importsPasswordHash('const m = await import("../login/password-hash");', "app/x")).toBe(true);
    expect(importsPasswordHash('import { d } from "./password-hash";', LOGIN_DIR)).toBe(true);
    expect(importsPasswordHash('import { d } from "./password-hash";', "app/other")).toBe(false);
  });

  it("no \"use client\" module imports app/admin/login/password-hash", () => {
    const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50); // the scan actually saw the tree
    const offenders = files
      .map((f) => ({ f, src: readFileSync(f, "utf8") }))
      .filter(({ src }) => isUseClient(src))
      .filter(({ f, src }) => importsPasswordHash(src, join(f, "..").slice(ROOT.length + 1)))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
