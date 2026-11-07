// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Discovery reads facilities through the read-only role (load-facilities.ts). Any
 * other module that reaches lib/db/client.ts, directly or through a lib/ module
 * that imports it, gets getDb(), which is built from DATABASE_URL: the owner
 * credential in .env.local. This guard makes each such use an explicit decision.
 *
 * Scans every .ts/.mjs under scripts/discovery/ (excluding tests) and parses
 * import specifiers (static import, export-from, dynamic import(), require()),
 * relative or "@/" alias. A file fails unless it is in ALLOWED_OWNER_DB below.
 * "DB-owner modules" are the transitive closure, computed at run time over every
 * non-test .ts/.mjs under lib/ and scripts/: a module that imports lib/db/client,
 * or imports another owner module, at any depth (lib/contribute -> lib/submissions
 * -> client). A new helper that wraps getDb() is caught without editing this file.
 *
 * Type-only imports are erased at build time and create no edge, so they are skipped.
 *
 * BOUNDARY: a tripwire for honest mistakes. It follows literal specifiers only, so
 * a specifier built from non-literal pieces is invisible to it, and so is a module
 * outside lib/ and scripts/ (e.g. app/) that a discovery file might import.
 */

const REPO = process.cwd();
const DISCOVERY = join(REPO, "scripts", "discovery");
const LIB = join(REPO, "lib");
const DB_CLIENT = "lib/db/client";

/** Every entry says why it may hold the owner credential. */
const ALLOWED_OWNER_DB: Record<string, string> = {
  "scripts/discovery/leads-lane.ts":
    "writes through lib/submissions and lib/leads (createSubmission, updateLeadStatus, promoteLead) as the owner",
  "scripts/discovery/publish-heartbeat.ts": "upserts the discovery_heartbeat row as the owner",
  "scripts/discovery/check-heartbeat.ts":
    "reads discovery_heartbeat; runs in CI (discovery-watchdog.yml) on the DATABASE_URL Actions secret (moving to ci_monitor)",
  "scripts/discovery/check-digest-status.ts":
    "reads the digest ledger; runs in CI (discovery-watchdog.yml) on the DATABASE_URL Actions secret (moving to ci_monitor)",
};

function sourceFiles(dir: string, includeTests = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...sourceFiles(full, includeTests));
    } else if (/\.(ts|mjs)$/.test(entry.name) && (includeTests || !/\.test\.(ts|mjs)$/.test(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** True for `import type ...`, `export type ...` and imports whose names are all inline `type` (erased at runtime). */
function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const c = node.importClause;
    if (!c) return false;
    if (c.isTypeOnly) return true;
    const named = c.namedBindings;
    return !c.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const c = node.exportClause;
  return !!c && ts.isNamedExports(c) && c.elements.length > 0 && c.elements.every((e) => e.isTypeOnly);
}

/** Module specifiers named by import/export-from/import()/require() in a source. */
export function specifiersOf(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !isTypeOnly(node)) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        out.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Repo-relative module path (no extension, no /index) for a specifier, or null for a package. */
export function resolveSpecifier(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith("@/")) abs = join(REPO, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(fromFile), spec);
  else return null;
  return posix
    .normalize(relative(REPO, abs).split("\\").join("/"))
    .replace(/\.(ts|mjs|js)$/, "")
    .replace(/\/index$/, "");
}

export function reachesOwnerDb(source: string, fileName: string, dbModules: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const spec of specifiersOf(source, fileName)) {
    const resolved = resolveSpecifier(spec, fileName);
    if (resolved === DB_CLIENT || (resolved !== null && dbModules.has(resolved))) hits.push(spec);
  }
  return hits;
}

/** Repo-relative module path of a source file, in the form resolveSpecifier returns. */
function moduleOf(file: string): string {
  return resolveSpecifier(`./${relative(dirname(file), file)}`, file) as string;
}

/**
 * Transitive closure: every module in `sources` (absolute path -> text) that
 * reaches lib/db/client through any chain of imports among those modules.
 * Iterates until the set stops growing.
 */
export function ownerModulesOf(sources: ReadonlyMap<string, string>): Set<string> {
  const owners = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, src] of sources) {
      const self = moduleOf(file);
      if (self === DB_CLIENT || owners.has(self)) continue;
      if (reachesOwnerDb(src, file, owners).length > 0) {
        owners.add(self);
        grew = true;
      }
    }
  }
  return owners;
}

/** DB-owner modules among lib/ and scripts/ (tests excluded); discovery files are included so a hop through one is seen. */
function ownerDbModules(): Set<string> {
  const sources = new Map<string, string>();
  for (const dir of [LIB, join(REPO, "scripts")]) {
    for (const file of sourceFiles(dir)) sources.set(file, readFileSync(file, "utf8"));
  }
  return ownerModulesOf(sources);
}

describe("discovery owner-DB import guard", () => {
  it("self-check: detects relative, alias, dynamic, require and export-from forms, and via a lib module", () => {
    const f = join(DISCOVERY, "x.ts");
    const mods = new Set(["lib/submissions"]);
    expect(reachesOwnerDb('import { getDb } from "../../lib/db/client";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('import { getDb } from "../../lib/db/client.ts";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('import { getDb } from "@/lib/db/client";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('const m = await import("../../lib/db/client");', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('const m = require("../../lib/db/client");', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('export { getDb } from "../../lib/db/client";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('import { createSubmission } from "../../lib/submissions";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb("// import x from '../../lib/db/client'\nconst s = 'lib/db/client';", f, mods)).toEqual([]);
    expect(reachesOwnerDb('import { facilitiesTable } from "../../lib/db/schema";', f, mods)).toEqual([]);
    expect(reachesOwnerDb('import path from "node:path";', f, mods)).toEqual([]);
    expect(reachesOwnerDb('import type { T } from "../../lib/submissions";', f, mods)).toEqual([]);
    expect(reachesOwnerDb('import { type T, type U } from "../../lib/submissions";', f, mods)).toEqual([]);
    expect(reachesOwnerDb('import { type T, createSubmission } from "../../lib/submissions";', f, mods)).toHaveLength(1);
    expect(reachesOwnerDb('export type { T } from "../../lib/submissions";', f, mods)).toEqual([]);
  });

  it("self-check: the closure follows a synthetic two-hop chain and ignores an unrelated module", () => {
    const at = (m: string) => join(REPO, `${m}.ts`);
    const owners = ownerModulesOf(
      new Map([
        [at("lib/zz-c"), 'import { x } from "./zz-b";'],
        [at("lib/zz-b"), 'import { getDb } from "@/lib/db/client";'],
        [at("scripts/zz-helper"), 'import { y } from "../lib/zz-c";'],
        [at("lib/zz-clean"), 'import { z } from "./zz-other";'],
        [at("lib/zz-other"), "export const z = 1;"],
      ])
    );
    expect([...owners].sort()).toEqual(["lib/zz-b", "lib/zz-c", "scripts/zz-helper"]);
  });

  it("finds modules that wrap getDb(), including two-hop chains, so the check is not vacuous", () => {
    const mods = ownerDbModules();
    expect(mods.has("lib/submissions")).toBe(true);
    expect(mods.has("lib/leads")).toBe(true);
    expect(mods.has("lib/contribute")).toBe(true);
    expect(mods.has(DB_CLIENT)).toBe(false);
  });

  it("only allowlisted discovery files reach lib/db/client", () => {
    const mods = ownerDbModules();
    const files = sourceFiles(DISCOVERY);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const rel = relative(REPO, file).split("\\").join("/");
      const hits = reachesOwnerDb(readFileSync(file, "utf8"), file, mods);
      if (hits.length === 0) continue;
      seen.add(rel);
      if (!(rel in ALLOWED_OWNER_DB)) offenders.push(`${rel} imports ${hits.join(", ")}`);
    }
    expect(offenders, "add the file to ALLOWED_OWNER_DB with a reason, or read through load-facilities.ts").toEqual([]);
    // A stale allowlist entry would silently permit a future regression.
    expect([...seen].sort()).toEqual(Object.keys(ALLOWED_OWNER_DB).sort());
  });
});
