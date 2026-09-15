import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Resolve from process.cwd() (the repo root Vitest runs from), matching
// app/admin/facilities/facility-form-state.test.ts. `import.meta.url` is an
// http:// URL under this project's jsdom environment, not a file:// one, so
// readFileSync rejects it outright.
const CSS = readFileSync(
  path.resolve(process.cwd(), "app/globals.css"),
  "utf8"
);

/**
 * The stylesheet with `/* ... *\/` comments blanked out. Needed by any check
 * that asks WHERE a token appears, because globals.css discusses its own
 * selectors in prose — a raw-text scan would count the commentary as code.
 */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Index of the `}` matching the `{` at `open`. */
function closeOf(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces in app/globals.css at index ${open}`);
}

/**
 * Bounds and body of an at-rule block by name, brace-balanced so a nested
 * `from { ... }` cannot terminate the match early.
 */
function atRuleBlock(header: string, searchFrom = 0, source: string = CSS) {
  const start = source.indexOf(header, searchFrom);
  if (start === -1) {
    throw new Error(`at-rule not found in app/globals.css: ${header}`);
  }
  const open = source.indexOf("{", start);
  const close = closeOf(source, open);
  return { start, open, close, body: source.slice(open + 1, close) };
}

/** Body of the at-rule block, for callers that only need its text. */
function atRuleBody(header: string, searchFrom = 0, source: string = CSS): string {
  return atRuleBlock(header, searchFrom, source).body;
}

/** Body of the innermost `{ ... }` block enclosing `at`. */
function enclosingBlockBody(source: string, at: number): string {
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    const c = source[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) return source.slice(i + 1, closeOf(source, i));
      depth -= 1;
    }
  }
  throw new Error(`no enclosing block in app/globals.css at index ${at}`);
}

/**
 * These assert on the STYLESHEET TEXT, not on rendered motion.
 *
 * That is the honest ceiling here: jsdom computes no layout, never applies a
 * `@supports`/`@media` block, and has no implementation of scroll-driven
 * animations (`animation-timeline: view()`), so there is no DOM state in which
 * a tilted plate is observable. Playwright cannot close the gap either — the
 * animation is driven by scroll position against a view() timeline, and what
 * it produces mid-range is a composited matrix, not a queryable style.
 *
 * So what is pinned is the DECLARATION: that the tilt exists in the keyframe,
 * that the settled state is square, and that both progressive-enhancement
 * gates still wrap the rule. Whether it LOOKS right is a human judgement that
 * no test in this repo makes.
 */
describe("app/globals.css — plate-settle keyframe", () => {
  const keyframe = atRuleBody("@keyframes plate-settle");

  const fromState = keyframe.match(/\bfrom\s*\{([^}]*)\}/)?.[1] ?? "";
  const toState = keyframe.match(/\bto\s*\{([^}]*)\}/)?.[1] ?? "";

  it("parses a from and a to state", () => {
    expect(fromState.trim()).not.toBe("");
    expect(toState.trim()).not.toBe("");
  });

  /**
   * The measured clipping ceiling (the overhang table in globals.css). Mobile
   * 358x700 is the BINDING viewport, not desktop: it overhangs the 16px px-4
   * gutter by 18.1px at 3deg while desktop still has 5px of room, so 2.5deg is
   * the last angle that fits on every breakpoint.
   */
  const MAX_TILT_DEG = 2.5;

  it("enters off-register: the from state carries a tilt within the clipping ceiling, and the lift", () => {
    const tilt = fromState.match(/rotate\(\s*(-?[\d.]+)deg\s*\)/);
    // Non-vacuity: a deleted, malformed or unit-less rotate must fail HERE,
    // rather than leave the bound checks below unreachable and silently green.
    expect(tilt, "from state must declare rotate(<n>deg)").not.toBeNull();

    const degrees = Math.abs(Number(tilt?.[1]));
    expect(Number.isFinite(degrees)).toBe(true);
    // There must BE a tilt: 0deg in `from` reduces the whole keyframe to a
    // fade with no off-register entry at all.
    expect(degrees).toBeGreaterThan(0);
    // Bounded, not pinned to an exact literal, because the bound is the half
    // of this with a physical basis — past it the plate's corner leaves the
    // gutter and visibly clips. The exact angle inside the bound is taste
    // (0.4deg read as nothing in a browser; 2deg is the current call) and will
    // move again, and an exact match would only ever be edited to match
    // whatever was just written. This assertion instead survives the taste
    // change and still fails the thing that is actually a defect.
    expect(degrees).toBeLessThanOrEqual(MAX_TILT_DEG);

    expect(fromState).toContain("translateY(8px)");
    // Composed into ONE transform, not two declarations — a second `transform`
    // would silently drop the first.
    expect(fromState.match(/transform\s*:/g) ?? []).toHaveLength(1);
  });

  it("settles square: the to state has zero rotation and zero offset", () => {
    expect(toState).toMatch(/rotate\(\s*0(?:deg)?\s*\)/);
    expect(toState).toContain("translateY(0)");
    // The settled state is also the UNANIMATED default every reduced-motion
    // and non-supporting browser sees, so a non-zero resting angle here would
    // ship a permanently crooked page to them. The `toMatch` above is what
    // says so — `rotate(0.4deg)` fails it, because `)` must follow the zero.
    // The negative regex below covers the one case that cannot: a SECOND,
    // non-zero rotate alongside a valid `rotate(0deg)` (e.g.
    // `rotate(0deg) rotate(2deg)`), which would satisfy the `toMatch`. It
    // deliberately does not match `0.4` — `0*[1-9]` cannot start at `0.`, so
    // do not delete the `toMatch` on the belief that this line covers it.
    expect(toState).not.toMatch(/rotate\(\s*-?0*[1-9][\d.]*\s*(?:deg|rad|grad|turn)?\s*\)/);
  });

  it("keeps the tilt behind both progressive-enhancement gates", () => {
    // globals.css has three `prefers-reduced-motion` blocks, so take the LAST
    // one opening before `.plate-reveal` — the one that actually wraps it.
    const MEDIA = "@media (prefers-reduced-motion: no-preference)";
    const ruleAt = CSS.indexOf(".plate-reveal {");
    expect(ruleAt).toBeGreaterThan(-1);
    const gateAt = CSS.lastIndexOf(MEDIA, ruleAt);
    expect(gateAt).toBeGreaterThan(-1);

    const reducedMotion = atRuleBody(MEDIA, gateAt);
    expect(reducedMotion).toContain("@supports (animation-timeline: view())");
    expect(reducedMotion).toContain(".plate-reveal");
    expect(reducedMotion).toContain("animation: plate-settle");
  });
});

/**
 * The two scrollbar styling paths must stay MUTUALLY EXCLUSIVE by construction.
 *
 * Why it matters, and why breaking it is invisible: Chromium >=121 ignores
 * `::-webkit-scrollbar` entirely on any element whose `scrollbar-color` is not
 * `auto`, and `scrollbar-color` INHERITS — so once `html` sets it, that is every
 * element. Ungated, the webkit rules read as live in source and do nothing in
 * the majority browser. Nothing errors, nothing looks different in review, and
 * the next reader edits dead code believing it ships. That is the whole reason
 * the `@supports not (scrollbar-color: auto)` wrapper exists, so it is the thing
 * worth pinning.
 *
 * WHAT THIS PROVES: only that the DECLARATION in app/globals.css is still shaped
 * that way. It does NOT prove any browser behaves as described above — that
 * claim comes from the Chromium behaviour change, not from this suite. jsdom
 * never evaluates `@supports`, renders no scrollbar, and implements no webkit
 * pseudo-elements, and Playwright cannot read a `::-webkit-scrollbar` rule back
 * out of a rendered page either. Text is the honest ceiling.
 *
 * Both checks run against the comment-stripped stylesheet: globals.css names
 * `::-webkit-scrollbar` in the prose directly above the gate, so a raw-text scan
 * would find an occurrence outside the block and fail for the wrong reason.
 */
describe("app/globals.css — webkit scrollbar fallback is gated", () => {
  const GATE = "@supports not (scrollbar-color: auto)";
  const WEBKIT = "::-webkit-scrollbar";

  it("declares every ::-webkit-scrollbar rule inside the @supports gate, and nowhere else", () => {
    // Throws with a named error if the gate is deleted outright, rather than
    // passing on a stylesheet that no longer has one.
    const gate = atRuleBlock(GATE, 0, CODE);

    const occurrences: number[] = [];
    for (let at = CODE.indexOf(WEBKIT); at !== -1; at = CODE.indexOf(WEBKIT, at + 1)) {
      occurrences.push(at);
    }

    // Non-vacuity: an empty set would satisfy the "all inside" check trivially.
    // If the fallback is ever removed on purpose, this assertion is the prompt
    // to delete the test deliberately instead of letting it go quiet.
    expect(occurrences.length).toBeGreaterThan(0);

    // Reported as source snippets, not indices, so a failure names the rule
    // that escaped the gate.
    const outside = occurrences
      .filter((at) => at < gate.open || at > gate.close)
      .map((at) => CODE.slice(Math.max(0, at - 60), at + 60).trim());
    expect(outside).toEqual([]);
  });

  it("never puts scrollbar-color and the webkit selectors in the same rule", () => {
    const gate = atRuleBlock(GATE, 0, CODE);

    // Inside the gate: no standard property. Setting `scrollbar-color` here
    // would make Chromium ignore the very rules the gate exists to preserve.
    expect(gate.body).not.toMatch(/scrollbar-color\s*:/);

    // Outside it: the rule that DOES set `scrollbar-color` carries no webkit
    // pseudo-element. Anchored by walking out from the declaration to its
    // enclosing block, so renaming the selector does not unhook the check.
    const declAt = CODE.search(/scrollbar-color\s*:/);
    expect(declAt).toBeGreaterThan(-1);
    // The first match must be the declaration, not the gate's own condition.
    expect(declAt).toBeLessThan(gate.start);

    const standardRule = enclosingBlockBody(CODE, declAt);
    expect(standardRule).toMatch(/scrollbar-width\s*:/);
    expect(standardRule).not.toContain(WEBKIT);
  });
});
