#!/usr/bin/env node
/**
 * Fails when a `console.*` call in `lib/` or `app/` logs a caught error OBJECT.
 *
 * WHY THIS GATE EXISTS. drizzle-orm wraps every driver error in a
 * `DrizzleQueryError` whose own `.message` is literally
 * `Failed query: <sql> params: <bound values>` — so the error object EMBEDS the
 * query's bound parameters. A 2026-09-27 audit found SEVEN sites logging one,
 * putting an IP hash, a subscriber's plaintext email and a live bearer token
 * into Vercel Runtime Logs. All seven were converted to
 * `redactedErrorCode(err)` (`lib/db-error.ts`), which logs the Postgres
 * SQLSTATE and nothing else. Nothing stopped an eighth. This does.
 *
 * WHY IT IS NOT A REGEX. Three regexes were tried the same day and each failed
 * SILENTLY — a lint that reports zero findings is indistinguishable from a
 * clean tree:
 *   - `[^)]*` stopped at a literal `)` inside a format string and missed
 *     `lib/facility-history.ts`.
 *   - An end-of-line anchor could not see a multi-line call and missed
 *     `lib/data.ts`.
 *   - A third matched comment prose as code.
 * This walks the real AST via TypeScript's own compiler API (`typescript` is
 * already a dependency), so a `)` in a string, a call spanning six lines and a
 * commented-out example are all handled by the parser rather than by pattern
 * luck. No type checker and no `tsconfig` resolution: `createSourceFile` alone
 * is enough and keeps the whole run well under a second.
 *
 * WHAT COUNTS AS A CAUGHT ERROR. Taint is seeded from two bindings and
 * propagated by assignment:
 *   - a `catch (err)` clause binding;
 *   - the parameter of a handler passed to `.catch(...)` or as the second
 *     argument to `.then(...)`.
 * Propagation matters and is not optional. `lib/data.ts`'s `withJsonFallback`
 * does `catch (err) { lastErr = err }` and then logs `lastErr` AFTER the loop —
 * outside the catch block entirely. Any scan confined to catch-clause bodies
 * reads that file as clean. Taint therefore flows through variable
 * declarations and plain `=` assignments, to a fixpoint, scoped to the
 * enclosing function.
 *
 * WHAT IS SAFE TO LOG, and why these are not an allowlist of files. A
 * reference to a tainted binding is accepted only in a form that cannot carry
 * bound params:
 *   - `redactedErrorCode(err)` — the sanctioned helper, SQLSTATE only.
 *   - `err.name` / `err.code` — a class name and a SQLSTATE.
 *   - `err instanceof Error` — a type guard, reads no data off the error.
 * Everything else is a finding: bare `err`, `err.message`, `err.stack`,
 * `err.cause`, `String(err)`, `JSON.stringify(err)`, `` `${err}` ``.
 *
 * DELIBERATELY NOT FLAGGED, by construction rather than by exception list:
 *   - `app/error.tsx` and `app/global-error.tsx` log a React error-boundary
 *     PROP, not a caught binding, so the taint rule never reaches them. They
 *     are also `"use client"` — the log lands in the visitor's own console, and
 *     Next sanitizes server errors in production. If they ever moved to a
 *     `catch`, this gate would start flagging them, which is the right
 *     behaviour: that would be a new decision, not the same one.
 *   - The ~15 `main().catch((err) => { console.error(err); process.exit(1) })`
 *     fatal handlers under `scripts/**` are out of scope because the scan roots
 *     are `lib/` and `app/` only. Those are maintainer tooling run by the data
 *     owner against their own terminal. If `scripts/` is ever added to the
 *     roots, expect ~15 findings that are all acceptable and need a real
 *     suppression mechanism first.
 *   - Test files (`*.test.ts` / `*.test.tsx`).
 *
 * DESTRUCTURING IS FOLLOWED, in the body. `catch (err) { const { message } =
 * err; console.error(message) }` is a finding, as is the renamed
 * `const { message: m } = err`. This was a silent hole until 2026-09-27: taint
 * propagation required an identifier binding, so an ObjectBindingPattern
 * propagated nothing. It is also the most PLAUSIBLE accidental shape of all —
 * pulling `const { message } = err` out is how three repeated `err.message`
 * reads get de-duplicated — so the gate was doing much less than it looked like.
 * Which names survive follows the same outermost-property rule as a property
 * chain: `const { code } = err` is clean, `{ ...rest }` and array patterns are
 * not. See `unsafeBoundNames`.
 *
 * KNOWN LIMITS, stated rather than implied. Taint does not follow an error into
 * a helper function (`logIt(err)` then `console.error(e)` inside `logIt`), a
 * destructured CATCH PARAMETER (`catch ({ message })` — the clause binding
 * itself, not a declaration in the body), a destructuring ASSIGNMENT to existing
 * variables (`({ message } = err)`), or a property write (`ctx.err = err`).
 * Taint is also per-function-scope and name-based, so it is neither
 * flow-sensitive nor block-scoped: a later unrelated `const message = "hi"` in
 * the same function inherits the name's taint, and only a nested FUNCTION scope
 * re-binding a name shadows it (see `ownBindings`). It is a guard against the
 * accidental eighth site, not a proof of absence.
 *
 * USAGE
 *   node scripts/lint-no-raw-error-logs.mjs          # exit 1 on any finding
 *   node scripts/lint-no-raw-error-logs.mjs --json   # machine-readable
 * Takes no env vars and has no opt-out: the default path is the only path, so
 * it cannot pass by being configured away.
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories scanned, relative to the repo root. Deployed code only. */
export const SCAN_ROOTS = ["lib", "app"];

/**
 * Calls whose return value is safe to log even when an error flows in. Keep
 * this list at one entry unless a second helper is genuinely proven to strip
 * bound params — every addition widens the hole this gate exists to close.
 */
const SAFE_SANITISERS = new Set(["redactedErrorCode"]);

/**
 * Properties of an error that carry no bound params. `message`, `stack` and
 * `cause` are deliberately ABSENT: `DrizzleQueryError.message` is where the
 * params live, `stack` begins with the message, and `cause` is the driver error
 * the message was built from.
 */
const SAFE_ERROR_PROPERTIES = new Set(["name", "code"]);

/**
 * Strips the wrappers that sit between a property access and the binding it is
 * really reading — `(err as { code?: string })?.code` is a read of `err.code`,
 * and `lib/contribute.ts` writes exactly that. Without this the scan reported a
 * false positive on a hand-rolled SQLSTATE extraction, which is the SAFE form.
 */
const unwrap = (node) => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * For a property-access chain, the identifier it is rooted at — so
 * `(err as T)?.cause?.code` resolves to `err`. Returns undefined for anything
 * not rooted at a bare identifier (a call result, an element access, `this`).
 */
function propertyChainRoot(node) {
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) ? current : undefined;
}

/**
 * Names bound by a destructuring pattern whose initializer is a tainted error,
 * minus the ones that can only ever hold a safe property.
 *
 * Mirrors the outermost-property rule in `findUnsafeReference`: the property a
 * name is read FROM is what decides. So `const { code } = err` and
 * `const { cause: { code } } = err` are clean — exactly like `err.code` and
 * `err.cause.code` — while `{ message }`, `{ stack }`, `{ cause }` and the
 * renamed `{ message: m }` are not.
 *
 * Two deliberate conservative cases. A REST element (`{ ...rest }`) always
 * taints: it carries every property nobody named, `message` among them, and its
 * identifier is a variable name rather than a property name — reading it as one
 * would let `const { ...code } = err` clear itself. An ARRAY pattern taints
 * unconditionally, because a positional element has no property name for
 * anything to judge.
 */
function unsafeBoundNames(pattern) {
  const names = [];
  const walk = (node) => {
    if (ts.isIdentifier(node)) {
      names.push(node.text);
      return;
    }
    if (ts.isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if (ts.isBindingElement(element)) walk(element.name);
      }
      return;
    }
    if (!ts.isObjectBindingPattern(node)) return;
    for (const element of node.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (element.dotDotDotToken) {
        walk(element.name);
        continue;
      }
      const property = element.propertyName ?? element.name;
      const named = ts.isIdentifier(property) || ts.isStringLiteral(property);
      // A computed key (`{ [k]: v }`) is not a readable property name, so it
      // falls through to the unsafe branch rather than being cleared.
      if (named && SAFE_ERROR_PROPERTIES.has(property.text)) continue;
      walk(element.name);
    }
  };
  walk(pattern);
  return names;
}

/** @type {WeakMap<ts.Node, Set<string>>} scope node -> names that scope itself binds */
const ownBindingsCache = new WeakMap();

/**
 * The names a scope binds ITSELF — its parameters plus its own declarations —
 * so an enclosing scope's taint can be dropped when an inner scope re-binds the
 * same name. `catch (e) {}` beside `.forEach((e) => console.error(e))` was a
 * finding without this: two unrelated variables that happen to share a name.
 *
 * Nested function scopes are not descended into; each owns its own bindings.
 * Block-scoped shadowing WITHIN one function scope is not modelled (taint here
 * is per-function and name-based), which is stated in KNOWN LIMITS above.
 */
function ownBindings(scope) {
  const cached = ownBindingsCache.get(scope);
  if (cached) return cached;

  const names = new Set();
  const addName = (name) => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addName(element.name);
      }
    }
  };

  for (const parameter of scope.parameters ?? []) addName(parameter.name);
  const walk = (node) => {
    if (node !== scope && isFunctionScope(node)) return;
    if (ts.isVariableDeclaration(node)) addName(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      addName(node.name);
    }
    ts.forEachChild(node, walk);
  };
  walk(scope);

  ownBindingsCache.set(scope, names);
  return names;
}

const isConsoleCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "console";

const isFunctionScope = (node) =>
  ts.isSourceFile(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

/** Nearest enclosing function-like node, or the source file. */
function scopeOf(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionScope(current)) return current;
  }
  return node.getSourceFile();
}

/**
 * Rejection handler of `p.catch(fn)` or `p.then(onOk, onErr)`. Returns the
 * handler node (which is the parameter's scope) and the parameter name, or
 * undefined when the call is neither shape or the handler takes no parameter.
 */
function rejectionHandler(call) {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const method = call.expression.name.text;
  const handler =
    method === "catch" ? call.arguments[0] : method === "then" ? call.arguments[1] : undefined;
  if (!handler) return undefined;
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return undefined;
  const [param] = handler.parameters;
  if (!param || !ts.isIdentifier(param.name)) return undefined;
  return { handler, name: param.name.text };
}

/**
 * Walks an expression looking for an UNSAFE reference to any tainted name.
 * Returns the offending sub-expression, or undefined when every reference it
 * finds is in one of the safe forms documented at the top of this file.
 */
function findUnsafeReference(expr, tainted) {
  let found;

  const visit = (node) => {
    if (found) return;

    // `redactedErrorCode(err)` — sanctioned, do not descend into the arguments.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SAFE_SANITISERS.has(node.expression.text)
    ) {
      return;
    }

    // `err instanceof Error` — a type guard; the left operand reads no data.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      visit(node.right);
      return;
    }

    // A property chain rooted at a tainted binding and ENDING in a safe
    // property: `err.name`, `err.code`, `(err as T)?.cause?.code`. Only the
    // outermost property decides, so `err.cause.message` and `err.message.length`
    // both fall through and are flagged, as does a computed access (`err[k]`).
    if (ts.isPropertyAccessExpression(node) && SAFE_ERROR_PROPERTIES.has(node.name.text)) {
      const root = propertyChainRoot(node);
      if (root && tainted.has(root.text)) return;
    }

    if (ts.isIdentifier(node) && tainted.has(node.text)) {
      // A name in a NAME position is not a read of the variable: the property
      // half of `something.err`, or the key of `{ err: 1 }`. (An object
      // shorthand `{ err }` IS a read, and is deliberately still flagged.)
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return;
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
  return found;
}

/**
 * Returns one finding per offending `console.*` argument in `sourceText`.
 * Exported so `scripts/lint-no-raw-error-logs.test.ts` can drive it with inline
 * sources — no fixture files, so nothing the real scan would then pick up.
 */
export function findRawErrorLogs(sourceText, fileName = "input.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  /** @type {Map<ts.Node, Set<string>>} scope node -> tainted names */
  const taint = new Map();
  /**
   * Tainted names visible from `scope`, including every enclosing scope, MINUS
   * any name an inner scope re-binds.
   *
   * ⚠️ Each scope's own taint is read BEFORE its own bindings join the shadow
   * set, and that order is load-bearing — swapping the two loops fails 25 of
   * this file's 41 tests, i.e. it disables the gate rather than narrowing it. A
   * scope both HOLDS taint and BINDS the name it is held under: a rejection
   * handler's parameter is the seeded binding (`p.catch((err) => …)` taints the
   * handler node), and a catch clause seeds its enclosing FUNCTION scope, which
   * also owns the clause's own variable declaration. Shadowing first would
   * therefore cancel every seed at its source. Reading first means shadowing can
   * only ever drop an OUTER scope's taint, which is the false positive it exists
   * to fix.
   */
  const taintedNamesFor = (scope) => {
    const names = new Set();
    const shadowed = new Set();
    for (let current = scope; current; current = ts.isSourceFile(current) ? undefined : scopeOf(current)) {
      for (const name of taint.get(current) ?? []) {
        if (!shadowed.has(name)) names.add(name);
      }
      for (const name of ownBindings(current)) shadowed.add(name);
      if (ts.isSourceFile(current)) break;
    }
    return names;
  };
  const addTaint = (scope, name) => {
    const existing = taint.get(scope);
    if (existing) {
      if (existing.has(name)) return false;
      existing.add(name);
      return true;
    }
    taint.set(scope, new Set([name]));
    return true;
  };

  // ── Pass 1: seed taint from catch bindings and rejection-handler params.
  const seed = (node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const { name } = node.variableDeclaration;
      if (ts.isIdentifier(name)) addTaint(scopeOf(node), name.text);
    }
    if (ts.isCallExpression(node)) {
      const rejection = rejectionHandler(node);
      if (rejection) addTaint(rejection.handler, rejection.name);
    }
    ts.forEachChild(node, seed);
  };
  seed(sourceFile);

  // ── Pass 2: propagate to a fixpoint. `lastErr = err` inside the catch, read
  // after the loop, is the case this exists for — and a later declaration can
  // taint an earlier-written console call, so one ordered pass is not enough.
  let changed = true;
  for (let round = 0; changed && round < 10; round++) {
    changed = false;
    const propagate = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const scope = scopeOf(node);
        if (findUnsafeReference(node.initializer, taintedNamesFor(scope))) {
          // `const e2 = err` taints the one name. A binding PATTERN taints each
          // name not read from a safe property — `const { message } = err` was
          // the gate's biggest blind spot, because requiring `isIdentifier` here
          // meant an ObjectBindingPattern propagated nothing at all.
          const names = ts.isIdentifier(node.name)
            ? [node.name.text]
            : unsafeBoundNames(node.name);
          for (const name of names) changed = addTaint(scope, name) || changed;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const scope = scopeOf(node);
        if (findUnsafeReference(node.right, taintedNamesFor(scope))) {
          changed = addTaint(scope, node.left.text) || changed;
        }
      }
      ts.forEachChild(node, propagate);
    };
    propagate(sourceFile);
  }

  // ── Pass 3: check every console.* argument.
  const findings = [];
  const check = (node) => {
    if (isConsoleCall(node)) {
      const names = taintedNamesFor(scopeOf(node));
      if (names.size > 0) {
        for (const arg of node.arguments) {
          const offender = findUnsafeReference(arg, names);
          if (!offender) continue;
          const { line } = sourceFile.getLineAndCharacterOfPosition(offender.getStart(sourceFile));
          findings.push({
            file: fileName,
            line: line + 1,
            binding: offender.text,
            call: `console.${node.expression.name.text}`,
            expression: arg.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, check);
  };
  check(sourceFile);

  return findings;
}

/** Every non-test `.ts`/`.tsx` file under the scan roots. */
export function collectFiles(root = REPO_ROOT) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return [full];
    });

  return SCAN_ROOTS.flatMap((dir) => walk(join(root, dir))).sort();
}

/**
 * Minimum scanned files expected under EACH root — a floor PER ROOT, never one
 * on the total. Measured 2026-09-27: `lib/` 81, `app/` 106, 187 total.
 *
 * WHY NOT A TOTAL: a total floor cannot detect losing a root. At 100, dropping
 * `app` fails but dropping `lib` leaves app/'s 106 and PASSES — and `lib/` is
 * where most of the original leak sites lived (`data.ts`, `submissions.ts`,
 * `facility-history.ts`, `search-db.ts`, `api-daily-limit.ts`). The floor has to
 * be denominated in the thing that can go missing.
 *
 * 50 sits well under the smaller root (81, so ordinary deletion churn will not
 * trip it) and well over any partial scan worth passing.
 */
export const MIN_FILES_PER_ROOT = 50;

/**
 * Scanned file count per root — the unit the floor is denominated in.
 *
 * `roots` is a PARAMETER, not a read of `SCAN_ROOTS`, and that is the whole
 * point. Keying off `SCAN_ROOTS` made this unable to detect the mutation it was
 * written for: delete `"lib"` from that array and there is no `lib` entry left
 * to be under-filled, so every count still cleared its floor. A caller that
 * wants to assert the root list is still the RIGHT list has to pass its own —
 * see `EXPECTED_SCAN_ROOTS` in the test.
 */
export function countByRoot(files, roots = SCAN_ROOTS, root = REPO_ROOT) {
  // Attributed by path containment, not substring: `app/lib/…` must not count
  // as `lib/`.
  const under = (dir, file) => {
    const rel = relative(join(root, dir), file);
    return rel !== "" && !rel.startsWith("..");
  };
  return Object.fromEntries(
    roots.map((dir) => [dir, files.filter((file) => under(dir, file)).length])
  );
}

/**
 * Roots whose scanned count is under the floor, formatted for a failure
 * message; `[]` means every root was really scanned.
 *
 * Exported and used by BOTH `main()` and the vitest suite on purpose, but with
 * DIFFERENT `roots`, because they are asking different questions. `main()`
 * passes `SCAN_ROOTS` — "did I actually scan the roots I claim to scan", which
 * is all a script can know about itself. The test passes its own literal list —
 * "is that claim still the right claim". The floor lived only in the test
 * before 2026-09-27, so `node scripts/…mjs` invoked directly (a pre-commit
 * hook, a workflow that doesn't run vitest) exited 0 on empty-but-present
 * roots. A *missing* root throws in `collectFiles`, so that half already failed
 * loud; this closes the half that didn't.
 */
export function underfilledRoots(files, roots = SCAN_ROOTS, root = REPO_ROOT) {
  const counts = countByRoot(files, roots, root);
  return roots
    .filter((dir) => counts[dir] < MIN_FILES_PER_ROOT)
    .map((dir) => `${dir}/ → ${counts[dir]} file(s), floor is ${MIN_FILES_PER_ROOT}`);
}

function main() {
  const asJson = process.argv.includes("--json");
  const files = collectFiles();
  const underfilled = underfilledRoots(files);
  const findings = files.flatMap((file) =>
    findRawErrorLogs(readFileSync(file, "utf8"), relative(REPO_ROOT, file))
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        { filesScanned: files.length, underfilledRoots: underfilled, findings },
        null,
        2
      )
    );
  } else {
    // Reported ALONGSIDE any findings, not instead of them — two independent
    // failures, each of which must still be visible when the other fires. The
    // two blocks below are deliberately not an if/else chain for that reason.
    if (underfilled.length > 0) {
      console.error(
        `✖ the scan covered too few files to mean anything:\n` +
          underfilled.map((root) => `  ${root}`).join("\n") +
          `\n\nA lint that scans nothing exits 0 exactly like a clean tree. Either a\n` +
          `SCAN_ROOTS entry was renamed or emptied, or this was not run from the\n` +
          `repo root. If a root genuinely shrank this far, lower\n` +
          `MIN_FILES_PER_ROOT deliberately and say why.\n`
      );
    }

    if (findings.length > 0) {
      console.error(
        `✖ ${findings.length} console.* call(s) log a caught error object ` +
          `(scanned ${files.length} files under ${SCAN_ROOTS.join(", ")}/):\n`
      );
      for (const f of findings) {
        console.error(`  ${f.file}:${f.line}  ${f.call}(… ${f.expression} …)`);
        console.error(`    '${f.binding}' is a caught error; log redactedErrorCode(${f.binding}) instead`);
      }
      console.error(
        "\nDrizzleQueryError.message embeds the query's bound params (an IP hash, a\n" +
          "subscriber email, a bearer token). Use redactedErrorCode() from lib/db-error.ts,\n" +
          "which logs the Postgres SQLSTATE only. See that file's header."
      );
    } else if (underfilled.length === 0) {
      // The file count is printed on success ON PURPOSE. A lint that silently
      // scanned nothing exits 0 exactly like a clean tree — this repo has had
      // that bug (a blast-radius lint scanned 0 files and passed).
      console.log(
        `no raw error logs — scanned ${files.length} files under ${SCAN_ROOTS.join(", ")}/`
      );
    }
  }

  // Captured as a plain status, never through a pipe — a pipeline's exit code
  // is the LAST command's, which has silently replaced a real failure here before.
  process.exitCode = findings.length === 0 && underfilled.length === 0 ? 0 : 1;
}

/**
 * "Was this run directly, or imported by the test?" `import.meta.main` is not
 * available on Node 22, so the paths are compared by hand — and they MUST be
 * compared as realpaths.
 *
 * ⚠️ This guard silently no-opped on the first probe. `import.meta.url` is
 * already resolved through symlinks while `process.argv[1]` is not, so invoking
 * the script through a symlinked directory (`/tmp` → `/private/tmp` on macOS,
 * and any `node_modules/.bin` shim) made the two disagree: `main()` never ran,
 * the process printed nothing, and it exited 0 — a gate reporting a clean tree
 * by not looking at it, which is this repo's most expensive recurring bug.
 * Nothing about the finding logic was wrong; the entry point was.
 */
function isRunDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isRunDirectly()) main();
