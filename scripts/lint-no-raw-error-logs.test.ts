import { describe, expect, it } from "vitest";

import {
  collectFiles,
  countByRoot,
  findRawErrorLogs,
  MIN_FILES_PER_ROOT,
  SCAN_ROOTS,
  underfilledRoots,
} from "./lint-no-raw-error-logs.mjs";

/**
 * Covers the detector in `scripts/lint-no-raw-error-logs.mjs` (the gate against
 * logging a caught error object, whose `.message` embeds Drizzle's bound params
 * — see `lib/db-error.ts`).
 *
 * The cases are driven with INLINE SOURCE STRINGS rather than fixture files, on
 * purpose: a fixture under `lib/` or `app/` would itself be scanned by the real
 * run, so a "must flag" fixture would permanently redden the gate it tests.
 *
 * The first three cases are the exact shapes three regexes silently missed on
 * 2026-09-27 — they are the reason this is an AST walk. Every case was also
 * run through the real CLI against a scratch copy of the tree before being
 * written down here, so these assertions describe measured behaviour rather
 * than intent.
 */
/**
 * The roots this gate MUST cover, as a literal — deliberately NOT read from the
 * script's `SCAN_ROOTS`. A test that derives its expectation from the value
 * under test cannot fail when that value is wrong; here, dropping a root would
 * have moved both sides of the comparison together.
 */
const EXPECTED_SCAN_ROOTS = ["lib", "app"];

describe("findRawErrorLogs", () => {
  const lines = (source: string) => findRawErrorLogs(source, "lib/probe.ts").map((f) => f.line);

  describe("catches the shapes a regex missed", () => {
    it("sees through a literal ')' inside the format string", () => {
      // `[^)]*` stopped at the ')' in "(retrying)" and read the rest as prose.
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) {
              console.error(\`insert failed (retrying) for \${err}\`);
            }
          }
        `)
      ).toEqual([4]);
    });

    it("sees a call spanning several lines", () => {
      // An end-of-line anchor could not reach the argument on the next line.
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) {
              console.warn(
                "lookup failed:",
                err
              );
            }
          }
        `)
      ).toEqual([6]);
    });

    it("does not mistake a commented-out example for code", () => {
      expect(
        lines(`
          export function f() {
            // Do not do this:
            //   } catch (err) { console.error("boom", err); }
            return 1;
          }
        `)
      ).toEqual([]);
    });
  });

  describe("flags every way an error object reaches the log", () => {
    const cases: [string, string][] = [
      ["the bare binding", "console.error(err)"],
      ["the message, where the bound params live", "console.error(err.message)"],
      ["a stringify", "console.error(String(err))"],
      ["a JSON serialisation", "console.error(JSON.stringify(err))"],
      ["the stack, which begins with the message", "console.error((err as Error).stack)"],
      ["the cause, which is the driver error", "console.error('x', err.cause)"],
      ["a nested message", "console.error(err.cause.message)"],
      ["an object-literal shorthand", "console.error({ err })"],
    ];

    for (const [label, call] of cases) {
      it(`flags ${label}`, () => {
        const source = `
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) { ${call}; }
          }
        `;
        expect(findRawErrorLogs(source, "lib/probe.ts")).toHaveLength(1);
      });
    }

    /**
     * The case that makes a catch-block-scoped scan useless.
     * `lib/data.ts`'s `withJsonFallback` assigns the error to a
     * function-scoped `lastErr` and logs it AFTER the retry loop — outside the
     * catch block entirely. That is a real, still-open finding in this repo,
     * not a hypothetical.
     */
    it("follows an error assigned out of the catch block and logged later", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            let lastErr: unknown;
            for (let i = 0; i < 3; i++) {
              try { return await Promise.reject(seed); } catch (err) { lastErr = err; }
            }
            console.warn("read failed:", lastErr);
          }
        `)
      ).toEqual([7]);
    });

    it("follows a single-level alias", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) { const e = err; console.error(e); }
          }
        `)
      ).toEqual([3]);
    });

    it("treats a promise rejection handler's parameter as a caught error", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            await Promise.reject(seed).catch((e) => console.error("handler", e));
          }
        `)
      ).toEqual([3]);
    });
  });

  /**
   * The gate's largest blind spot until 2026-09-27: taint propagation required
   * an identifier binding, so an `ObjectBindingPattern` propagated NOTHING and
   * `const { message } = err` scanned clean. It is also the most plausible
   * accidental shape there is — de-duplicating three `err.message` reads. Which
   * bound names survive follows the same outermost-property rule as a property
   * chain, so the clean cases below are the ones `err.code` / `err.cause.code`
   * would also clear.
   */
  describe("follows an error through a destructuring declaration", () => {
    const body = (declaration: string, logged: string) => `
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) { ${declaration} console.error(${logged}); }
          }
        `;

    const flagged: [string, string, string][] = [
      ["a shorthand message binding", "const { message } = err;", "message"],
      ["a RENAMED message binding", "const { message: m } = err;", "m"],
      ["a stack binding", "const { stack } = err;", "stack"],
      ["a cause binding", "const { cause } = err;", "cause"],
      ["a nested unsafe binding", "const { cause: { message } } = err;", "message"],
      ["a rest element, which carries message", "const { ...rest } = err;", "rest"],
      // Would clear itself if the rest identifier were read as a property name.
      ["a rest element NAMED like a safe property", "const { ...code } = err;", "code"],
      // No property name exists to judge, so nothing can clear it.
      ["an array pattern element", "const [first] = err as unknown as string[];", "first"],
      ["a computed key, which is not a readable name", "const { ['message']: v } = err;", "v"],
      ["a pattern two hops from the catch", "const e2 = err; const { message } = e2;", "message"],
    ];

    for (const [label, declaration, logged] of flagged) {
      it(`flags ${label}`, () => {
        expect(lines(body(declaration, logged))).toEqual([3]);
      });
    }

    const clean: [string, string, string][] = [
      ["a code binding", "const { code } = err;", "code"],
      ["a name binding", "const { name } = err;", "name"],
      ["a renamed code binding", "const { code: c } = err;", "c"],
      ["a nested safe binding", "const { cause: { code } } = err;", "code"],
    ];

    for (const [label, declaration, logged] of clean) {
      it(`accepts ${label}`, () => {
        expect(lines(body(declaration, logged))).toEqual([]);
      });
    }

    it("does not flag a destructure of something that was never caught", () => {
      // Guards against the fix over-reaching into every binding pattern.
      expect(
        lines(`
          export function f(o: { message: string }) {
            const { message } = o;
            console.error(message);
          }
        `)
      ).toEqual([]);
    });
  });

  /**
   * `e` and `err` are among the most common parameter names there are, so an
   * inner scope re-binding one must not inherit the outer catch's taint. This
   * was never a live failure (0 findings over 187 real files), but a spurious
   * red in a required CI job is what creates pressure to weaken a gate.
   */
  describe("does not inherit taint across a shadowing binding", () => {
    it("ignores a callback parameter that merely shares the catch's name", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (e) { /* handled */ }
            [1, 2].forEach((e) => console.error(e));
          }
        `)
      ).toEqual([]);
    });

    it("ignores an inner declaration that shadows the catch's name", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (e) { /* handled */ }
            const h = () => { const e = 1; console.error(e); };
            return h;
          }
        `)
      ).toEqual([]);
    });

    it("STILL flags a rejection handler's own parameter", () => {
      // The ordering guard: a handler's parameter is itself the seeded binding,
      // so a shadow check applied before reading a scope's own taint would
      // silently blind the gate to the shape it was written for.
      expect(
        lines(`
          export async function f(seed: unknown) {
            await Promise.reject(seed).catch((err) => console.error(err));
          }
        `)
      ).toEqual([3]);
    });

    it("STILL flags a nested closure reading the outer catch binding", () => {
      expect(
        lines(`
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) {
              setTimeout(() => console.error(err), 0);
            }
          }
        `)
      ).toEqual([4]);
    });
  });

  describe("accepts the forms that carry no bound params", () => {
    const cases: [string, string][] = [
      ["the sanctioned helper", "console.error(`failed (sqlstate: ${redactedErrorCode(err)})`)"],
      ["the helper as an argument", "console.error('failed', redactedErrorCode(err))"],
      ["the class name behind a type guard", "console.error('f:', err instanceof Error ? err.name : 'unknown')"],
      ["a hand-rolled SQLSTATE read", "console.error('failed', (err as { code?: string })?.code ?? 'unknown')"],
      ["a nested SQLSTATE read", "console.error('failed', (err as { cause?: { code?: string } })?.cause?.code)"],
    ];

    for (const [label, call] of cases) {
      it(`accepts ${label}`, () => {
        const source = `
          import { redactedErrorCode } from "@/lib/db-error";
          export async function f(seed: unknown) {
            try { await Promise.reject(seed); } catch (err) { ${call}; }
          }
        `;
        expect(findRawErrorLogs(source, "lib/probe.ts")).toEqual([]);
      });
    }

    /**
     * `app/error.tsx` and `app/global-error.tsx` log a React error-boundary
     * PROP. They are classified acceptable (a `"use client"` boundary logs to
     * the visitor's own console, and Next sanitizes server errors in
     * production) — and the gate skips them by construction rather than by a
     * path allowlist, because the taint only ever starts at a caught binding.
     * An allowlist would also have to be maintained; this does not.
     */
    it("ignores a React error-boundary prop, which is not a caught binding", () => {
      expect(
        lines(`
          "use client";
          export default function Error({ error }: { error: Error }) {
            console.error(error);
            return null;
          }
        `)
      ).toEqual([]);
    });
  });

  /**
   * The failure this repo keeps re-learning: a lint that scans nothing exits 0
   * exactly like a clean tree. (A blast-radius lint once scanned 0 files and
   * passed; the entry-point guard in this very script silently no-opped on its
   * first probe for a different reason.) A floor on the file count means an
   * empty scan is a red test rather than a green one.
   *
   * PER ROOT, not on the total — the total-only floor of 100 could be satisfied
   * by the wrong half. Measured: `lib/` 81, `app/` 106. Dropping `app` failed
   * it, but dropping `lib` left 106 and PASSED, and `lib/` is where most of the
   * original leak sites lived. The floor and its message both live in the
   * script (`underfilledRoots`), so `node scripts/…mjs` run on its own enforces
   * the same thing this test does; asserting through that function is what
   * keeps the two from drifting.
   */
  it("scans a real, non-trivial set of files under EVERY expected root", () => {
    const files = collectFiles();
    // Counted over the LITERAL list, never over `SCAN_ROOTS`. Measured while
    // writing this: passing `SCAN_ROOTS` made every assertion here survive the
    // mutation it exists for — remove `"lib"` from the array and there is no
    // `lib` key left to be under-filled, so `app`'s 106 files satisfied
    // everything. A floor is only a floor if the thing that can go missing is
    // named independently of the code that might drop it.
    const counts = countByRoot(files, EXPECTED_SCAN_ROOTS);

    // Catches the root list being narrowed or renamed in the script.
    expect([...SCAN_ROOTS].sort()).toEqual([...EXPECTED_SCAN_ROOTS].sort());

    // The LITERAL 50, not `MIN_FILES_PER_ROOT` — asserting a measurement
    // against the constant it is measured by cannot fail, because lowering the
    // constant moves the assertion with it. Pinning the constant separately is
    // what makes a weakened floor a red test.
    expect(MIN_FILES_PER_ROOT).toBe(50);
    for (const root of EXPECTED_SCAN_ROOTS) {
      expect(counts[root], `${root}/ scanned only ${counts[root]} file(s)`).toBeGreaterThan(50);
    }

    // The script's own predicate, so `node scripts/…mjs` on its own enforces
    // the same floor this test does.
    expect(
      underfilledRoots(files, EXPECTED_SCAN_ROOTS),
      `a scan root came back near-empty, so the gate passes vacuously for ` +
        `everything under it: ${JSON.stringify(counts)}`
    ).toEqual([]);
  });

  it("scans no test files, whose fixtures would be false positives", () => {
    expect(collectFiles().filter((f: string) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });
});
