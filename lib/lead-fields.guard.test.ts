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
