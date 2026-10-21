/**
 * Regression guard for the client-bundle-break fixed alongside this file:
 * app/admin/leads/lead-list.tsx is a "use client" component that used to
 * import LEAD_STATUSES/LeadStatus/LeadTriage/AdminLeadRow from lib/leads.ts.
 * LEAD_STATUSES is a runtime value, so the bundler pulled lib/leads.ts's
 * whole module graph into the client bundle: lib/leads.ts -> lib/contribute.ts
 * -> lib/submissions.ts -> lib/facility-write.ts -> next/cache's
 * revalidateTag, a Server-Component-only API. That failed the production
 * build (Turbopack: "You're importing a module that depends on
 * 'revalidateTag' ... in the Pages Router").
 *
 * The fix split the client-safe constants/types into lib/lead-fields.ts (a
 * leaf with no server-only dependencies) and pointed the client component at
 * it directly. This test asserts that leaf never regrows a server-only
 * import — a re-merge, or a new import creeping in, would fail this test
 * instead of shipping a broken build silently (search-index.guard.test.ts
 * covers the sibling failure mode for lib/search.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Matches a value OR type import of any of the disallowed server-only
// modules, as the target of `from "..."` or `import("...")`, in either quote
// style. The `(?![\w-])` after each alternative stops the match at a word
// boundary, so `@/lib/contribute` does NOT false-positive on the client-safe
// `@/lib/contribute-fields` sibling (and likewise for the other roots).
const DISALLOWED_IMPORT =
  /(?:from\s+|import\s*\(\s*)["'](?:@\/lib\/db\/client|@\/lib\/submissions|@\/lib\/contribute|@\/lib\/facility-write)(?![\w-])/;

describe("DISALLOWED_IMPORT pattern sanity", () => {
  it("matches from/import() in both quote styles", () => {
    expect('import { getDb } from "@/lib/db/client";').toMatch(DISALLOWED_IMPORT);
    expect("import { getDb } from '@/lib/db/client';").toMatch(DISALLOWED_IMPORT);
    expect('import { createSubmission } from "@/lib/submissions";').toMatch(DISALLOWED_IMPORT);
    expect('import { httpUrlSchema } from "@/lib/contribute";').toMatch(DISALLOWED_IMPORT);
    expect('import { writeFacility } from "@/lib/facility-write";').toMatch(DISALLOWED_IMPORT);
    expect('const x = await import("@/lib/facility-write");').toMatch(DISALLOWED_IMPORT);
  });

  it("does not false-positive on the client-safe siblings this leaf is allowed to use", () => {
    expect('import type { LeadRow } from "@/lib/db/schema";').not.toMatch(DISALLOWED_IMPORT);
    expect('import { httpUrlSchema } from "@/lib/intake-fields";').not.toMatch(DISALLOWED_IMPORT);
    expect('import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";').not.toMatch(
      DISALLOWED_IMPORT
    );
  });
});

describe("client bundle guard: lib/lead-fields.ts must stay a server-free leaf", () => {
  it("lib/lead-fields.ts does not import any server-only module", () => {
    const source = readSource("lib/lead-fields.ts");
    expect(source).not.toMatch(DISALLOWED_IMPORT);
  });

  it("app/admin/leads/lead-list.tsx imports lead constants/types from the client-safe leaf, not lib/leads", () => {
    const source = readSource("app/admin/leads/lead-list.tsx");
    expect(source).not.toMatch(/from\s+["']@\/lib\/leads["']/);
    expect(source).toMatch(/from\s+["']@\/lib\/lead-fields["']/);
  });

  it("lib/leads.ts still re-exports the lead-fields leaf for server-side callers (the split has not been merged back)", () => {
    const source = readSource("lib/leads.ts");
    expect(source).toMatch(/from\s+["']@\/lib\/lead-fields["']/);
  });
});

describe("client bundle guard: lib/contribute-fields.ts must stay a server-free leaf", () => {
  // lib/contribute-fields.ts is imported by components/contribute/suggest-
  // correction.tsx, a "use client" component, so it is genuinely reachable
  // from the client bundle the same way lib/lead-fields.ts is above. It grew
  // an import of communityStatusEnum/energySourceEnum/waterCoolingTypeEnum
  // from lib/schema.ts, which is fine today (schema.ts only imports zod +
  // the client-safe lib/status and lib/intake-fields leaves — see the note at
  // the top of lib/schema.ts), but nothing stops that import list from
  // growing a server-only dependency later. Guarding both files here means
  // that regression fails this test instead of shipping a broken build.
  it("lib/contribute-fields.ts does not import any server-only module", () => {
    const source = readSource("lib/contribute-fields.ts");
    expect(source).not.toMatch(DISALLOWED_IMPORT);
  });

  it("lib/schema.ts (the hop that makes lib/contribute-fields.ts safe) does not import any server-only module either", () => {
    const source = readSource("lib/schema.ts");
    expect(source).not.toMatch(DISALLOWED_IMPORT);
  });
});

// lib/correction-input.ts is imported by components/contribute/suggest-
// correction.tsx ("use client"), and it promises to be a pure leaf: its only
// import is `import type`, which is erased at build time. A RUNTIME import, of
// anything, would put that module (and whatever it pulls in) in the client
// bundle, so this is stricter than DISALLOWED_IMPORT: no value import at all.
// Matches `import x from`, `import { x } from`, `import * as x`, a bare
// `import "x"` (indented, or with no spaces: `import{z}from"zod"`), a dynamic
// `import(`, `require(`, and a re-export (`export { x } from`, `export * from`,
// `export * as n from`, with or without spaces, indented or not).
// `import type` (any spacing) is erased and allowed. A type re-export
// (`export type { X } from "y"`) is erased too, but is flagged DELIBERATELY:
// the leaf has no reason to re-export anything, and a looser rule is harder to
// trust than a strict one. Applied to the whole file with the `m` flag, so `^`
// is any line start.
const RUNTIME_IMPORT =
  /^\s*import\b(?!\s+type\b)|\bimport\s*\(|\brequire\s*\(|^\s*export\s*(?:type\b\s*)?(?:\*(?:\s*as\s*\w+)?|\{[^}]*\})\s*from\b/m;

describe("RUNTIME_IMPORT pattern sanity", () => {
  it("matches each line-leading way of pulling in a runtime dependency", () => {
    expect('import { z } from "zod";').toMatch(RUNTIME_IMPORT);
    expect('import z from "zod";').toMatch(RUNTIME_IMPORT);
    expect('import * as z from "zod";').toMatch(RUNTIME_IMPORT);
    expect('import "side-effect";').toMatch(RUNTIME_IMPORT);
    expect('const m = await import("zod");').toMatch(RUNTIME_IMPORT);
    expect('const m = require("zod");').toMatch(RUNTIME_IMPORT);
    expect('export { x } from "./x";').toMatch(RUNTIME_IMPORT);
    expect('// header\nimport { z } from "zod";').toMatch(RUNTIME_IMPORT);
  });

  it("matches the shapes a looser pattern misses: no spaces, indented, and star re-exports", () => {
    expect('import{z}from"zod";').toMatch(RUNTIME_IMPORT);
    expect('  import { z } from "zod";').toMatch(RUNTIME_IMPORT);
    expect('\timport z from "zod";').toMatch(RUNTIME_IMPORT);
    expect('export { x } from "y";').toMatch(RUNTIME_IMPORT);
    expect('export * from "y";').toMatch(RUNTIME_IMPORT);
    expect('export * as ns from "y";').toMatch(RUNTIME_IMPORT);
    expect('export {\n  a,\n  b,\n} from "y";').toMatch(RUNTIME_IMPORT);
  });

  it("matches re-exports with no spaces, an indent, or a quote straight after `from`", () => {
    expect('export{x} from "y";').toMatch(RUNTIME_IMPORT);
    expect('export {x}from"y";').toMatch(RUNTIME_IMPORT);
    expect('export * from"y";').toMatch(RUNTIME_IMPORT);
    expect('export*from"y";').toMatch(RUNTIME_IMPORT);
    expect('  export { x } from "y";').toMatch(RUNTIME_IMPORT);
    expect('\texport * as ns from"y";').toMatch(RUNTIME_IMPORT);
  });

  it("flags a type-only re-export too, on purpose", () => {
    expect('export type { X } from "y";').toMatch(RUNTIME_IMPORT);
    expect('export type {X}from"y";').toMatch(RUNTIME_IMPORT);
  });

  it("does not match a type-only import, single- or multi-line, or comments that mention import", () => {
    expect('import type { CorrectableKey } from "@/lib/contribute-fields";').not.toMatch(RUNTIME_IMPORT);
    expect('import type {\n  A,\n  B,\n} from "@/lib/x";').not.toMatch(RUNTIME_IMPORT);
    expect('import  type { A } from "@/lib/x";').not.toMatch(RUNTIME_IMPORT); // two spaces
    expect('  import type { A } from "@/lib/x";').not.toMatch(RUNTIME_IMPORT); // indented
    expect("// a type-only import and pure string handling").not.toMatch(RUNTIME_IMPORT);
    expect("export type ParsedNumber = { ok: true };").not.toMatch(RUNTIME_IMPORT);
    expect("export function fromage() {}").not.toMatch(RUNTIME_IMPORT);
    expect("export const x = { from: 1 };").not.toMatch(RUNTIME_IMPORT);
  });
});

describe("client bundle guard: lib/correction-input.ts must stay a dependency-free leaf", () => {
  it("has no runtime import of any kind (only `import type`)", () => {
    const source = readSource("lib/correction-input.ts");
    expect(source).not.toMatch(RUNTIME_IMPORT);
  });

  it("does not import any server-only module", () => {
    const source = readSource("lib/correction-input.ts");
    expect(source).not.toMatch(DISALLOWED_IMPORT);
  });
});
