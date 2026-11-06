// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Process-level contract: db:sync refuses an insecure API_BASE_URL in its pre-flight, before
// any database access, so a dummy DATABASE_URL is enough.
const ROOT = resolve(__dirname, "..");

describe("db:sync pre-flight — real subprocess", () => {
  it("refuses --apply when API_BASE_URL is plain http to a non-loopback host", () => {
    const res = spawnSync(resolve(ROOT, "node_modules/.bin/tsx"), ["scripts/sync-to-neon.ts", "--apply"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
        API_BASE_URL: "http://www.example.com",
        API_ADMIN_TOKEN: "sekret-token",
      },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Refusing to apply[\s\S]*http:\/\/www\.example\.com/);
    expect(res.stderr + res.stdout).not.toContain("sekret-token");
  });
});
