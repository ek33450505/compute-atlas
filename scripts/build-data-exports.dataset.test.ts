import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import { facilitiesToCsv, facilitiesToJson } from "@/lib/export";
import type { Facility } from "@/lib/schema";
import { buildDataExports } from "./build-data-exports";

// Real-dataset invariants (DATASET=real, npm run test:dataset). The default run
// checks the same logic against the committed fixture in build-data-exports.test.ts.

const SNAPSHOT_PATH = path.join(process.cwd(), "data", "facilities.json");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "data-exports-real-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildDataExports (real snapshot)", () => {
  it("reports the real record count", () => {
    const result = buildDataExports(SNAPSHOT_PATH, path.join(dir, "out"));
    expect(result.count).toBe((facilitiesRaw as unknown[]).length);
    expect(result.count).toBeGreaterThan(0);
  });

  it("golden: static CSV and JSON equal the client-side exporters' output byte for byte", () => {
    const facilities = facilitiesRaw as unknown as Facility[];
    const result = buildDataExports(SNAPSHOT_PATH, dir);
    expect(readFileSync(result.csvPath, "utf8")).toBe(facilitiesToCsv(facilities));
    expect(readFileSync(result.jsonPath, "utf8")).toBe(facilitiesToJson(facilities));
  });

  it("agrees with the committed facilities.meta.json", () => {
    const meta = path.join(process.cwd(), "data", "facilities.meta.json");
    expect(() => buildDataExports(SNAPSHOT_PATH, dir, meta)).not.toThrow();
  });
});
