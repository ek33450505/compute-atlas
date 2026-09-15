import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STATUS_ORDER } from "@/lib/status";

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

/**
 * Body of a rule located by the literal text that opens it (selector + `{`).
 * Brace-balanced like `atRuleBlock`, and reads CODE rather than CSS so a
 * selector discussed in the surrounding prose cannot be mistaken for the rule.
 */
function ruleBody(opener: string, source: string = CODE): string {
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`rule not found in app/globals.css: ${opener}`);
  }
  const open = source.indexOf("{", start);
  return source.slice(open + 1, closeOf(source, open));
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
 * So what is pinned is the DECLARATION: that the container reveal fades and
 * lifts WITHOUT rotating, that the hover tilt exists at an angle inside its
 * measured ceiling, and that both progressive-enhancement gates still wrap the
 * rules they belong to. Whether either LOOKS right is a human judgement that
 * no test in this repo makes.
 */
const MEDIA = "@media (prefers-reduced-motion: no-preference)";

describe("app/globals.css — plate-settle keyframe", () => {
  const keyframe = atRuleBody("@keyframes plate-settle");

  const fromState = keyframe.match(/\bfrom\s*\{([^}]*)\}/)?.[1] ?? "";
  const toState = keyframe.match(/\bto\s*\{([^}]*)\}/)?.[1] ?? "";

  /** `rotate(...)`, `rotateZ(...)`, `rotate3d(...)` — any transform rotation. */
  const ROTATE_FN = /\brotate(?:[XYZ]|3d)?\s*\(/;
  /** The `rotate:` longhand, the other way to turn an element. */
  const ROTATE_LONGHAND = /(?:^|[;{\s])rotate\s*:/;

  it("parses a from and a to state", () => {
    expect(fromState.trim()).not.toBe("");
    expect(toState.trim()).not.toBe("");
  });

  it("enters with the lift and the fade", () => {
    expect(fromState).toContain("translateY(8px)");
    expect(fromState).toMatch(/opacity\s*:\s*0\b/);
    expect(toState).toContain("translateY(0)");
    expect(toState).toMatch(/opacity\s*:\s*1\b/);
    // Composed into ONE transform per state, not two declarations — a second
    // `transform` would silently drop the first.
    expect(fromState.match(/transform\s*:/g) ?? []).toHaveLength(1);
    expect(toState.match(/transform\s*:/g) ?? []).toHaveLength(1);
  });

  it("does NOT rotate: the container tilt was removed, and re-adding one fails here", () => {
    // Asserted POSITIVELY rather than by deletion. The container used to enter
    // at 2deg and turn square; Ed removed that on 2026-09-15 in favour of the
    // per-card hover tilt, which is a taste call someone could very reasonably
    // mistake for damage and "restore". This is the test that says it was
    // deliberate.
    for (const [name, state] of [
      ["from", fromState],
      ["to", toState],
    ] as const) {
      const transform = state.match(/transform\s*:\s*([^;}]+)/);
      // Non-vacuity: a state that lost its transform entirely must fail HERE,
      // rather than make the two no-rotate checks below trivially true by
      // having nothing left to read.
      expect(transform, `${name} state must declare a transform`).not.toBeNull();
      expect(transform?.[1], `${name} state must not rotate`).not.toMatch(ROTATE_FN);
      // Both spellings, because `rotate: 2deg` turns the plate just as far and
      // would sail past a check that only knew the transform function.
      expect(state, `${name} state must not use the rotate longhand`).not.toMatch(
        ROTATE_LONGHAND
      );
    }
  });

  it("keeps the reveal behind both progressive-enhancement gates", () => {
    // globals.css has several `prefers-reduced-motion` blocks, so take the LAST
    // one opening before `.plate-reveal` — the one that actually wraps it.
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
 * The hover tilt (`.plate-hover`), which is where the off-register metaphor
 * lives now that the container reveal no longer rotates.
 *
 * Same honest ceiling as the block above, for one more reason: jsdom has no
 * `:hover` state to enter and never applies a `@media` block, so there is no
 * DOM in which a tilted card is observable. Playwright could hover, but what
 * `getComputedStyle` returns mid-transition is a composited matrix, not the
 * authored angle. The DECLARATION is the honest thing to pin.
 */
describe("app/globals.css — plate-hover tilt", () => {
  /**
   * The SOLVED card ceiling (the card table in globals.css): the angle at
   * which the lens gateway's widest card grows past its 12px row gap. That
   * card is the single-column one at a 639px viewport — 639 - 2x16 = 607px,
   * the widest instance of the tightest grid — not the phone-width card; a
   * grid's binding case is the viewport just below its next breakpoint.
   * Per-band ceilings run 2.27deg (that card, vertical growth) to 9.87deg
   * (contested's narrowest 3-col card); the tightest horizontal constraint is
   * looser still at 5.92deg. The minimum governs, and 2.26 is it rounded DOWN
   * so the literal stays a true bound (2.266deg for a zero-height card, the
   * pessimistic limit — a taller card grows less).
   *
   * This bound is loose-ish — 4.5x the 0.5deg shipped — so it catches "this
   * became a novelty spin", not "0.5 drifted to 1.5". Pinning the exact
   * literal instead would fail on every taste change and be edited to match
   * whatever was just written, which is not a test. What is NOT bounded here
   * is whether the angle reads well; that needs a browser and a person.
   *
   * It previously read 4.3, inherited from a card table whose widths had the
   * page gutter subtracted twice — i.e. it would have passed a 4.0deg tilt
   * that clips a neighbouring card.
   */
  const MAX_CARD_TILT_DEG = 2.26;

  it("declares the tilt inside the reduced-motion gate", () => {
    // Against CODE, the comment-stripped sheet: globals.css names
    // `.plate-hover` in the prose above the rule, so a raw-text scan could
    // anchor on the commentary instead of the declaration.
    const ruleAt = CODE.indexOf(".plate-hover {");
    expect(ruleAt).toBeGreaterThan(-1);
    const gateAt = CODE.lastIndexOf(MEDIA, ruleAt);
    expect(gateAt).toBeGreaterThan(-1);

    // The unanimated state must be the square, settled, fully-usable card, so
    // a reduced-motion reader loses nothing. That only holds while BOTH the
    // transition and the transform live inside this block — a rule hoisted out
    // of the gate would tilt for everyone, including people who asked the
    // operating system not to animate.
    const reducedMotion = atRuleBody(MEDIA, gateAt, CODE);
    expect(reducedMotion).toContain(".plate-hover {");
    expect(reducedMotion).toContain(".plate-hover:hover {");
    expect(reducedMotion).toMatch(/transform\s*:\s*rotate\(/);
  });

  it("tilts on :hover only, within the solved card ceiling", () => {
    const body = ruleBody(".plate-hover:hover {");

    const tilt = body.match(/transform\s*:\s*rotate\(\s*(-?[\d.]+)deg\s*\)/);
    // Non-vacuity: a deleted, malformed or unit-less rotation must fail HERE,
    // rather than leave the bound checks below unreachable and silently green.
    // `rotate(0.5)` without the unit is invalid CSS and would be dropped by the
    // parser, shipping no tilt at all while reading fine in a diff.
    expect(tilt, ":hover must declare transform: rotate(<n>deg)").not.toBeNull();

    const degrees = Math.abs(Number(tilt?.[1]));
    expect(Number.isFinite(degrees)).toBe(true);
    // There must BE a tilt: 0deg is a no-op rule that still costs a stacking
    // context and a containing block on every hover.
    expect(degrees).toBeGreaterThan(0);
    expect(degrees).toBeLessThanOrEqual(MAX_CARD_TILT_DEG);
  });

  it("re-declares the colour transitions it displaces", () => {
    const body = ruleBody(".plate-hover {");

    // This rule is emitted after Tailwind's generated utilities in the same
    // @layer, so at equal specificity its `transition-property` REPLACES the
    // card's `transition-colors` outright — an element carries exactly one
    // such list. Listing only `transform` would silently kill the existing
    // hover:bg / hover:border fades on every card, with no trace in the class
    // list and nothing to see in a diff of this file.
    const props = body.match(/transition-property\s*:\s*([^;}]+)/)?.[1];
    expect(props, ".plate-hover must declare transition-property").toBeDefined();
    // Compare as a SET of comma-separated names, never with `toContain` on the
    // raw string: `"background-color".includes("color")` is true, so a
    // substring check for `color` cannot fail while `background-color` is
    // present — it would pass over the exact regression this test exists for.
    const declared = new Set(
      (props ?? "").split(",").map((property) => property.trim())
    );
    for (const property of [
      "transform",
      "color",
      "background-color",
      "border-color",
    ]) {
      expect(declared, `transition-property must list ${property}`).toContain(
        property
      );
    }
    // The resting state must carry no transform of its own: one there would
    // make every card a permanent containing block for fixed/absolute
    // descendants and a permanent stacking context, which is exactly what
    // scoping the rotation to :hover avoids.
    expect(body).not.toMatch(/(?:^|[;{\s])transform\s*:/);
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
/**
 * Dark mode was deleted deliberately (see the comment at the top of
 * app/globals.css). Two assertions, guarding two different failure modes:
 *
 *  1. the `@custom-variant dark` line must not come back, and
 *  2. no dark-variant utility may reappear in the sources.
 *
 * The second is the one that matters. The dark variant is BUILT IN to Tailwind;
 * the deleted line only re-pointed it at a `.dark` ancestor. Such a class
 * with no such redefinition resolves to `@media (prefers-color-scheme: dark)`,
 * so it would style the site for every OS-dark visitor — the exact regression
 * the removal order was chosen to avoid.
 */
describe("app/globals.css — no dark mode", () => {
  // Built at runtime so this file can scan for the token without matching
  // itself, which lets the sweep below cover tests as well as sources.
  const DARK_VARIANT = `${"dark"}:`;

  it("declares no dark custom-variant", () => {
    // CODE, not CSS: the replacement comment quotes the deleted line verbatim,
    // and a raw-text scan would read that prose as code (see CODE's docblock).
    expect(CODE).not.toContain("@custom-variant dark");

    // Nothing else may reintroduce a class-based dark scope either.
    expect(CODE).not.toMatch(/\.dark\b/);

    // The prose explaining the decision is load-bearing for the next reader,
    // so a silent deletion of the comment fails here too.
    expect(CSS).toContain("There is no dark mode, on purpose");
  });

  it("ships no dark-variant utility in any tracked file", () => {
    // Enumerated from `git ls-files`, NOT from a hand-written root list.
    //
    // Tailwind v4 is configured here with no config file and no `@source`, so
    // its automatic content detection scans every non-gitignored file in the
    // project — which is the tracked set, near enough. A root list ("app",
    // "components", "lib") is therefore narrower than the thing it claims to
    // guard: `e2e/`, `scripts/`, `test/`, `docs/`, `drizzle/`, `.github/` and
    // `data/` are all tracked, so a dark-variant class landing in any of them
    // compiles into the shipped stylesheet AND passes a root-scoped sweep.
    // Deriving the list closes that hole for directories nobody has created
    // yet, which is how the hole was born in the first place.
    //
    // Tracked, not `--others`: a file that is untracked-but-unignored IS
    // scanned by Tailwind on the author's machine, but it cannot reach a build
    // — Vercel builds from git. Scanning it would only fail this suite on other
    // people's scratch files.
    let tracked: string[];
    try {
      tracked = execFileSync("git", ["ls-files", "-z"], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
        .split("\0")
        .filter(Boolean);
    } catch (cause) {
      // Fail LOUDLY rather than fall back to an empty list. Without git (a
      // tarball checkout, a CI image without it) the honest outcome is "this
      // guard could not run", never a green tick over zero files.
      throw new Error(
        "cannot enumerate tracked files: `git ls-files` failed, so the " +
          "dark-variant sweep has no source of truth to scan",
        { cause }
      );
    }

    // Deny-list, not allow-list — the same reasoning as the roots. Tailwind
    // extracts candidate class names from any text file it scans, so listing
    // the extensions to INCLUDE would leave the next one (.mdx, .vue, a plain
    // shell script) silently unguarded. Excluded here: true binaries only,
    // where a utf8 read is meaningless noise. Everything else is read —
    // .ts/.tsx/.mjs/.md/.json/.yml/.sh/.bats/.sql/.svg/.py and extensionless
    // files alike. Reading the whole tracked set costs ~20ms for ~22MB.
    const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|ttf|otf|woff2?|eot|mp4|webm|mov|zip|gz|pdf)$/i;
    // app/globals.css is excluded for one specific reason: the comment at the
    // top of it names the token five times (across four lines) while explaining
    // why the variant was removed, and that prose is load-bearing for the next
    // reader — a line scan would report every one of them. Its coverage
    // is the comment-stripped CODE assertion below, which is strictly stronger
    // for this file than a line scan would be.
    const EXCLUDED = new Set(["app/globals.css"]);

    const scanned = tracked.filter(
      (file) => !BINARY.test(file) && !EXCLUDED.has(file)
    );

    // Non-vacuity: an enumeration that silently produced nothing would satisfy
    // the emptiness check below without reading a single byte. This repo has
    // shipped that false green before (a lint that scanned 0 files, exited 0),
    // and it is the reason the catch above throws instead of returning [].
    expect(scanned.length).toBeGreaterThan(400);
    expect(scanned).toContain("components/ui/button.tsx");
    // Pin the widening itself, not just a count: these are the roots the
    // previous root list missed. A regression that narrows the enumeration back
    // to app/components/lib fails HERE, naming what it stopped covering, rather
    // than going quiet and passing.
    for (const root of ["e2e/", "scripts/", "test/", "docs/"]) {
      expect(
        scanned.some((file) => file.startsWith(root)),
        `the sweep must cover ${root}`
      ).toBe(true);
    }

    const offenders: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      if (!text.includes(DARK_VARIANT)) continue;
      text.split("\n").forEach((line, i) => {
        if (line.includes(DARK_VARIANT)) offenders.push(`${file}:${i + 1}`);
      });
    }

    // Reported as paths so a failure names the file to strip.
    expect(offenders).toEqual([]);

    // The stylesheet's own path back to the hazard, invisible to the sweep
    // above twice over: globals.css is excluded from it, and an `@apply`
    // directive is not a class in a source file at all. globals.css uses
    // `@apply` three times, so `@apply` + a dark-variant utility would
    // reintroduce exactly the regression this suite exists to prevent, and
    // neither the file sweep nor the custom-variant check would see it.
    // CODE, not CSS — the five occurrences in the explanatory comment are
    // prose and must not trip this.
    expect(CODE).not.toContain(DARK_VARIANT);
  });
});

/**
 * Typographic rules added in the type-and-texture pass.
 *
 * Same ceiling as the block above: these assert the DECLARATION, because
 * every one of them is a property jsdom neither parses meaningfully nor
 * lays out. `text-wrap` needs a line-breaking engine; `font-variation-settings`
 * needs a variable font binary and a shaper. So what a passing run here claims
 * is that the rule is present, correctly scoped, and sets the axes/values it
 * is supposed to — NOT that a heading balances, that SOFT 40 is visible, or
 * that the versal is legible. Those are browser facts, unverified here.
 */
describe("app/globals.css — line-breaking defaults", () => {
  const base = atRuleBody("@layer base");

  it("balances headings and prettifies paragraphs, inside @layer base", () => {
    // Scoped to the base layer deliberately: a bare element selector in
    // @layer utilities would outrank every component class, and one outside
    // any layer would outrank the whole Tailwind cascade.
    expect(base).toMatch(/h1\s*,\s*h2\s*,\s*h3\s*\{[^}]*text-wrap\s*:\s*balance/);
    expect(base).toMatch(/(?:^|[;{}\s])p\s*\{[^}]*text-wrap\s*:\s*pretty/);
  });

  it("does not put balance on paragraphs, where the UA gives up anyway", () => {
    // `balance` is superlinear and browsers abandon it past ~6-10 lines, so on
    // body copy it buys nothing and costs layout. If someone "upgrades" the
    // paragraph rule, this is what says no.
    const paragraphRule = base.match(/(?:^|[;{}\s])p\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(paragraphRule).not.toContain("balance");
  });

  it("applies the heading rule to h1-h3 only", () => {
    // h4-h6 are sub-sub-headings here and are short enough that balancing
    // them is churn. Pinned so the selector cannot quietly widen to `h4`.
    const headingSelector = base.match(/(h1\s*,\s*h2\s*,\s*h3)\s*\{[^}]*text-wrap/)?.[1];
    expect(headingSelector).toBeTruthy();
    expect(base).not.toMatch(/h4[^{]*\{[^}]*text-wrap/);
  });
});

describe("app/globals.css — Fraunces variable axes", () => {
  const wonk = ruleBody(".font-display-wonk {");
  const dropCap = ruleBody(".drop-cap::first-letter {");
  const display = ruleBody(".font-display {");

  /** The two axes app/layout.tsx loads but nothing varied before this pass. */
  const AXES = /font-variation-settings\s*:\s*"SOFT"\s+40\s*,\s*"WONK"\s+1/;

  it("varies SOFT and WONK in the display utility", () => {
    expect(wonk).toMatch(AXES);
  });

  it("carries the same axes on the drop-cap versal", () => {
    // ::first-letter is not an element and cannot take a utility class, so
    // the axes are restated rather than composed. Both sites are pinned so
    // the two cannot drift into different display voices.
    expect(dropCap).toMatch(AXES);
  });

  it("sets neither opsz nor wght, so the high-level properties still win", () => {
    // font-variation-settings overrides the high-level font properties PER
    // AXIS (CSS Fonts 4 §6.13). Naming `opsz` here would beat
    // `font-optical-sizing: auto` and pin ONE optical size across the h1's
    // 5xl→7xl steps; naming `wght` would beat the versal's `font-weight: 600`.
    // This is the assertion that keeps that from being reintroduced.
    for (const body of [wonk, dropCap]) {
      const settings = body.match(/font-variation-settings\s*:([^;]*)/)?.[1] ?? "";
      expect(settings).not.toContain("opsz");
      expect(settings).not.toContain("wght");
    }
  });

  it("keeps optical sizing and the versal weight declared alongside", () => {
    expect(display).toMatch(/font-optical-sizing\s*:\s*auto/);
    expect(dropCap).toMatch(/font-optical-sizing\s*:\s*auto/);
    expect(dropCap).toMatch(/font-weight\s*:\s*600/);
  });
});

describe("app/globals.css — chart series bound to the status palette", () => {
  const root = ruleBody(":root {");

  it("maps --chart-1..5 onto the status hues in STATUS_ORDER", () => {
    // Derived from STATUS_ORDER rather than a second hand-written list: if the
    // order in lib/status.ts changes, this fails against the unchanged
    // stylesheet and names the drift, which is the whole hazard the binding
    // introduces.
    STATUS_ORDER.forEach((status, index) => {
      const token = `--status-${status.replace(/_/g, "-")}`;
      expect(root).toMatch(
        new RegExp(`--chart-${index + 1}\\s*:\\s*var\\(\\s*${token}\\s*\\)`)
      );
    });
  });

  it("leaves no greyscale shadcn default behind", () => {
    // The pre-pass values were `oklch(L 0 0)` — chroma 0, hue 0. A chart var
    // still holding one means the rebinding was partially reverted.
    for (let n = 1; n <= STATUS_ORDER.length; n += 1) {
      const value = root.match(new RegExp(`--chart-${n}\\s*:([^;]*)`))?.[1] ?? "";
      expect(value.trim()).not.toBe("");
      expect(value).not.toMatch(/oklch\(/);
    }
  });

  it("declares exactly as many chart vars as there are statuses", () => {
    // A sixth status added without a sixth chart var (or vice versa) silently
    // leaves one series unbound; the count is what catches that.
    const declared = (root.match(/--chart-\d+\s*:/g) ?? []).length;
    expect(declared).toBe(STATUS_ORDER.length);
  });
});

describe("app/globals.css — the 44px graticule module", () => {
  it("draws every graticule surface on the same 44px grid", () => {
    // The page's one spatial constant. The hero plate sits on this grid, and
    // the comment on `.graticule` asks the surfaces still to land (the
    // specimen card, the status-over-time chart) to adopt it. If any of the
    // three existing surfaces drifts to a different pitch, the hero stops
    // reading as one plate — and nothing else in the suite would notice.
    for (const rule of [".graticule {", ".grat-axis-x {", ".grat-axis-y {"]) {
      const body = ruleBody(rule);
      expect(body).toContain("44px");
      // No second pitch hiding in the same rule.
      const pitches = new Set(
        [...body.matchAll(/transparent\s+1px\s+(\d+)px/g)].map((m) => m[1])
      );
      expect([...pitches]).toEqual(["44"]);
    }
  });
});
