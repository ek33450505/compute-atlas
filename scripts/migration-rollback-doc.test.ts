import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("0021 rollback block in docs/maintainers.md", () => {
  it("deletes the migration record by the journal's own `when`, and no other created_at literal", () => {
    const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0021_commercial_tier");
    expect(entry).toBeDefined();

    const doc = readFileSync(join(ROOT, "docs/maintainers.md"), "utf8");
    const start = doc.indexOf("DROP TABLE IF EXISTS commercial_checkouts;");
    expect(start).toBeGreaterThan(-1);
    const block = doc.slice(start, doc.indexOf("COMMIT;", start));

    expect(block).toContain(`created_at = ${entry!.when};`);
    const literals = [...block.matchAll(/created_at\s*=\s*(\d{13})/g)].map((m) => m[1]);
    expect(literals).toEqual([String(entry!.when)]);
  });
});
