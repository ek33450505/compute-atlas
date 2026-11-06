import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_SEARCH_QUERY_LEN } from "@/lib/search-limits";
import * as searchDb from "@/lib/search-db";

// These modules are reachable from client code; they must stay free of server-only deps.
const CLIENT_SAFE = ["lib/explorer-params.ts", "lib/table-query.ts"];
const FORBIDDEN = ["@/lib/search-db", "@/lib/db", "drizzle-orm", "next/cache"];

describe("client-safe query modules", () => {
  it.each(CLIENT_SAFE)("%s imports no server-only module", (file) => {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    for (const mod of FORBIDDEN) {
      expect(src, `${file} must not import ${mod}`).not.toMatch(
        new RegExp(`from\\s+["']${mod}(/[^"']*)?["']`)
      );
    }
  });

  it("search-db still re-exports the query cap", () => {
    expect(searchDb.MAX_SEARCH_QUERY_LEN).toBe(MAX_SEARCH_QUERY_LEN);
  });
});
