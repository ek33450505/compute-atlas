/**
 * Regression guard for the client-bundle-size defect fixed alongside this
 * file: `components/search/command-palette.tsx` is a `"use client"`
 * component that imports `@/lib/search`. Before the fix, `@/lib/search` also
 * imported `@/lib/data`, which statically imports the ~2.8 MB
 * `data/facilities.json` — so the whole dataset rode into the client JS
 * bundle on every route (via `SiteHeader` in the root layout): a 748 KB
 * brotli / 2.9 MB parsed JS chunk, present on every page. The fix moved the
 * `@/lib/data` read into a new server-only sibling, `lib/search-index.ts`.
 *
 * This failure mode is SILENT: no build error, no type error, no test
 * failure — it shipped for an unknown period before anyone noticed. These
 * assertions exist so a re-merge of the two modules, or a new `@/lib/data`
 * import creeping into the client-reachable module graph, fails a test
 * instead of shipping quietly. See the file-header comment in
 * `lib/search-index.ts` for the full narrative.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

// Matches a module specifier of `@/lib/data` (optionally with a `.js`/`.jsx`/
// `.ts`/`.tsx` extension) or the exact `@/data/facilities.json`, when used as
// the target of `from "..."`, `import("...")`, or `require("...")`, in
// either quote style.
//
// Deliberately does NOT match:
//   - `@/lib/database` (or any other `@/lib/data*` sibling) — after the
//     literal "@/lib/data", the pattern requires either a recognized
//     extension or the closing quote immediately next; "database"'s
//     trailing "base" satisfies neither, so the match fails there.
//   - `@/lib/data-utils`, `@/lib/dataset`, etc. — same reasoning.
//   - the bare word "data" in prose/comments — the pattern only fires
//     around an actual quoted module specifier preceded by
//     from/import(/require(, which a comment doesn't contain.
// Not handled (out of scope for this guard): relative-path imports of the
// same files, e.g. `from "../data"` — the codebase consistently uses the
// `@/` alias, so this isn't exercised in practice.
const DATA_MODULE_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](@\/lib\/data(?:\.(?:js|jsx|ts|tsx))?|@\/data\/facilities\.json)["']/;

describe("DATA_MODULE_IMPORT pattern sanity", () => {
  it("matches from/import()/require() in both quote styles, with or without an extension", () => {
    expect('import x from "@/lib/data";').toMatch(DATA_MODULE_IMPORT);
    expect("import x from '@/lib/data';").toMatch(DATA_MODULE_IMPORT);
    expect('import x from "@/lib/data.ts";').toMatch(DATA_MODULE_IMPORT);
    expect('import { loadFacilitiesForSearch } from "@/lib/data";').toMatch(DATA_MODULE_IMPORT);
    expect('const x = await import("@/lib/data");').toMatch(DATA_MODULE_IMPORT);
    expect('import raw from "@/data/facilities.json";').toMatch(DATA_MODULE_IMPORT);
  });

  it("does not false-positive on @/lib/database, sibling data-* paths, or comment prose", () => {
    expect('import { getDb } from "@/lib/database";').not.toMatch(DATA_MODULE_IMPORT);
    expect('import { x } from "@/lib/data-utils";').not.toMatch(DATA_MODULE_IMPORT);
    expect('import { x } from "@/lib/dataset";').not.toMatch(DATA_MODULE_IMPORT);
    expect("// process the data here, then see @/lib/data in prose").not.toMatch(DATA_MODULE_IMPORT);
    expect("const data = 5;").not.toMatch(DATA_MODULE_IMPORT);
  });
});

describe("client bundle guard: data/facilities.json must never reach the browser via search", () => {
  it("lib/search.ts does not import @/lib/data or @/data/facilities.json", () => {
    const source = readSource("lib/search.ts");
    expect(source).not.toMatch(DATA_MODULE_IMPORT);
  });

  it("command-palette.tsx imports only from the known client-safe allowlist", () => {
    const source = readSource("components/search/command-palette.tsx");
    // Derived from the file's current imports (2026-08-16). Anything not in
    // this set — most importantly `@/lib/data` — fails the assertion below.
    const allowlist = new Set([
      "react",
      "next/navigation",
      "@base-ui/react/dialog",
      "lucide-react",
      "@/lib/utils",
      "@/lib/search",
      "@/lib/schema",
    ]);
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    // Sanity check on the extraction itself — if this ever hits 0, the
    // regex stopped matching the file's import style and the allowlist
    // check below would pass vacuously.
    expect(specifiers.length).toBeGreaterThan(0);

    const disallowed = specifiers.filter((s) => !allowlist.has(s));
    expect(disallowed).toEqual([]);
    expect(specifiers).not.toContain("@/lib/data");
  });

  it("lib/search-index.ts still reads @/lib/data (the split has not been merged back)", () => {
    const source = readSource("lib/search-index.ts");
    expect(source).toMatch(DATA_MODULE_IMPORT);
  });
});
