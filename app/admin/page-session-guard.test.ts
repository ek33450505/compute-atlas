import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * A STRUCTURAL invariant over every admin page: each `page.tsx` must gate
 * itself with `hasAdminSession()` rather than rely on proxy.ts alone.
 *
 * WHY: Vercel matches DYNAMIC routes case-insensitively while proxy.ts's
 * `/admin/:path*` matcher is case-sensitive, so `/ADMIN/facilities/<id>`
 * skipped the cookie gate and rendered the page unauthenticated (measured on
 * production 2026-11-09). The page itself is the only gate that cannot be
 * bypassed by path casing.
 */

const ADMIN_ROOT = "app/admin";

/** The guard as a CALL, so a comment mentioning it cannot satisfy the check. */
const GUARD_CALL =
  /^if\s*\(\s*!\s*\(\s*await\s+hasAdminSession\s*\(\s*\)\s*\)\s*\)\s*redirect\(\s*["']\/admin\/login["']\s*\)/;

/**
 * Pages ungated BY DESIGN. `login` is the unauthenticated entry point (a
 * client component); gating it would deadlock sign-in.
 */
const UNGATED_BY_DESIGN: readonly string[] = ["app/admin/login/page.tsx"];

/** Floor on GATED pages (8 today), so a broken scan cannot pass vacuously. */
const MIN_GATED_PAGES = 8;

function adminPages(): string[] {
  const entries = readdirSync(join(process.cwd(), ADMIN_ROOT), {
    recursive: true,
    encoding: "utf8",
  });
  return entries
    .filter((entry) => /(^|[\\/])page\.tsx$/.test(entry))
    .map((entry) => join(ADMIN_ROOT, entry).split("\\").join("/"));
}

/**
 * The default export's body from its first code statement onward (NOT just
 * that statement), comments skipped. GUARD_CALL is anchored to the start of
 * this string and carries no `m` flag, so only the first statement can match;
 * with `m`, an unindented guard line later in the file would satisfy it.
 * Parameters may span several lines, so the signature is matched up to the
 * first `{` that ends a line.
 */
function firstStatement(source: string): string | undefined {
  const sig = /export default async function \w+\([\s\S]*?\)\s*\{[ \t]*\n/.exec(source);
  if (!sig) return undefined;
  const body = source.slice(sig.index + sig[0].length);
  // Strip leading whitespace, `//` lines and `/* */` blocks.
  return body.replace(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
}

describe("admin pages — hasAdminSession is structurally required", () => {
  it("discovers enough gated admin pages", () => {
    const gated = adminPages().filter((file) => !UNGATED_BY_DESIGN.includes(file));
    expect(gated.length).toBeGreaterThanOrEqual(MIN_GATED_PAGES);
  });

  it("anchors the guard to the first statement (synthetic pages)", () => {
    const guard = 'if (!(await hasAdminSession())) redirect("/admin/login");';
    const late = `export default async function P() {\n  const x = await load();\n${guard}\n  return x;\n}\n`;
    const first = `export default async function P({\n  a,\n}: {\n  a: string;\n}) {\n  // comment\n  ${guard}\n  return a;\n}\n`;

    expect(GUARD_CALL.test(firstStatement(late) ?? "")).toBe(false);
    expect(GUARD_CALL.test(firstStatement(first) ?? "")).toBe(true);
  });

  it("names exceptions that exist on disk", () => {
    for (const file of UNGATED_BY_DESIGN) {
      expect(existsSync(join(process.cwd(), file)), `${file} is gone; drop the stale exception`).toBe(true);
      expect(adminPages()).toContain(file);
    }
  });

  it("gates every page that is not ungated by design", () => {
    const ungated = adminPages()
      .filter((file) => !UNGATED_BY_DESIGN.includes(file))
      .filter(
        (file) =>
          !GUARD_CALL.test(firstStatement(readFileSync(join(process.cwd(), file), "utf8")) ?? "")
      );

    expect(
      ungated,
      `Admin page(s) without \`if (!(await hasAdminSession())) redirect("/admin/login");\` as the FIRST statement of the default export:\n  ${ungated.join("\n  ")}\n\n` +
        `Vercel matches dynamic routes case-insensitively, so proxy.ts's case-sensitive ` +
        `matcher can be skipped via /ADMIN/... . Move or add it ahead of any data read. If ` +
        `a page is genuinely public, add it to UNGATED_BY_DESIGN with the reason.`
    ).toEqual([]);
  });
});
