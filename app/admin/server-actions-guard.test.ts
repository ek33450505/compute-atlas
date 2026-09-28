import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/**
 * A STRUCTURAL invariant over every admin server action: each one must call
 * `assertAdminSession`.
 *
 * WHY THIS EXISTS: each of the current actions is individually unit-tested, but
 * nothing stopped a NEWLY ADDED action from shipping ungated — the guard was a
 * convention held up by nine separate tests that a tenth action would simply not
 * have. This file is the thing a new action cannot avoid — subject to the
 * declaration-FORM caveat under "ACTION discovery" below, which is what the
 * second case in this file exists to close.
 *
 * WHY IT MATTERS MORE THAN A ROUTE GATE: a React server action is invoked by
 * POSTing its action id to ANY path in the app, not to a URL of its own. So
 * `proxy.ts`'s admin-cookie check on `/admin/*` is not what protects it — an
 * ungated action is reachable through a path proxy.ts deliberately allow-lists,
 * `/admin/login` among them. The only gate is the one inside the function body.
 *
 * FILE discovery is by the `"use server"` DIRECTIVE, not by filename: a future
 * `app/admin/leads/mutations.ts` is just as privileged as `actions.ts`, and a
 * filename glob would not see it.
 *
 * ACTION discovery inside a found file is by FORM — `export async function` —
 * and that was the hole: `export const fooAction = async () => {}` was
 * invisible to the scan, and `MIN_EXPORTED_ACTIONS` could not catch it either,
 * because an unseen action does not lower the count. "A new action cannot avoid
 * this" was therefore true only because all 11 current actions happen to use
 * the function form. The "rejects action declarations the scan cannot see" case
 * below closes that: the alternative forms now fail loudly and say what to do,
 * instead of being silently skipped.
 */

/** Scanned recursively for modules carrying the `"use server"` directive. */
const ADMIN_ROOT = "app/admin";

/** The guard every privileged action must call. */
const GUARD = "assertAdminSession";

/**
 * The guard as a CALL, not a substring. `body.includes(GUARD)` was satisfied by
 * a mere mention, so `// TODO: assertAdminSession` in a comment would have
 * discharged a security invariant. Used in BOTH directions below — the
 * invariant and its `UNGATED_BY_DESIGN` exception list share this one
 * predicate, so they cannot disagree about what "calls the guard" means.
 */
const GUARD_CALL = new RegExp(`await\\s+${GUARD}\\s*\\(`);

/**
 * Declaration forms `exportedActions` cannot see. Each would be a privileged
 * export that the invariant below skips in silence, so they are rejected
 * outright rather than supported — one recognised form keeps the scan simple
 * and its failure message actionable.
 *
 * Honest scope: these match a directly-declared `async` initializer, which is
 * the form a new action would most plausibly reach for. A wrapped initializer
 * (`export const a = withX(async () => {})`) is still invisible; it is also
 * not a form anything in this app uses, and `exportedActions` would have to
 * parse expressions to see it.
 */
const INVISIBLE_ACTION_FORMS: readonly { pattern: RegExp; form: string }[] = [
  // Greedy `[^\n]*` so a type annotation containing `=>` still backtracks to
  // the real initializer (`export const a: () => Promise<void> = async …`).
  {
    pattern: /^export\s+(?:const|let|var)\s+(\w+)\b[^\n]*=\s*async\b/gm,
    form: "export const <name> = async …",
  },
  // No exported name at all for the scan to key on.
  { pattern: /^export\s+default\s+async\b/gm, form: "export default async …" },
];

/**
 * Actions that are ungated BY DESIGN — stated here so the exception is on the
 * record rather than hidden in a passing test:
 *
 * - `login`  — the UNAUTHENTICATED entry point. Requiring a session to sign in
 *              would deadlock the admin UI. Its own protections are a per-IP
 *              rate limit and a constant-time password compare.
 * - `logout` — only clears the session cookie. Refusing to clear it without a
 *              valid session would strand anyone holding a stale one.
 *
 * Adding a name here is adding an exception to a security invariant; say why.
 */
const UNGATED_BY_DESIGN: readonly string[] = ["login", "logout"];

/**
 * Floors, not exact counts — 5 files / 11 exported actions at the time of
 * writing. They exist so a scan that silently matches NOTHING fails instead of
 * passing vacuously; growing past them is expected and needs no edit here.
 */
const MIN_SERVER_ACTION_FILES = 5;
const MIN_EXPORTED_ACTIONS = 11;

/**
 * The directive as a STATEMENT — its own line, optional indentation. Matches
 * both the module-level form these files use and the inline per-function form,
 * which is the sneakier way to introduce a privileged export. Cannot match the
 * string inside a comment sentence, which is why `facility-form-state.test.ts`
 * (excluded anyway) is not the reason for the anchoring.
 */
const USE_SERVER_DIRECTIVE = /^\s*["']use server["'];?\s*$/m;

interface ExportedAction {
  /** Repo-relative path, for the failure message. */
  file: string;
  name: string;
  /** The function body only — see `exportedActions` for how it is delimited. */
  body: string;
}

/** Every non-test `.ts`/`.tsx` under `app/admin` carrying the directive. */
function serverActionFiles(): string[] {
  const entries = readdirSync(join(process.cwd(), ADMIN_ROOT), {
    recursive: true,
    encoding: "utf8",
  });

  const files: string[] = [];
  for (const entry of entries) {
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    const file = join(ADMIN_ROOT, entry);
    if (!USE_SERVER_DIRECTIVE.test(readFileSync(join(process.cwd(), file), "utf8"))) continue;
    files.push(file);
  }
  return files;
}

/**
 * Exported async functions and their bodies, delimited by this repo's
 * prettier formatting: the body's opening `{` ends a line, and a top-level
 * declaration's closing `}` sits alone at column 0. Throws rather than
 * guessing if either marker is missing — a silent mis-parse could swallow a
 * whole file into one "body" and make the invariant unfalsifiable. The
 * "extracts one body per action" case below is the standing check on that.
 */
function exportedActions(file: string): ExportedAction[] {
  const lines = readFileSync(join(process.cwd(), file), "utf8").split("\n");
  const actions: ExportedAction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const declared = /^export async function (\w+)/.exec(lines[i]);
    if (!declared) continue;
    const name = declared[1];

    let open = i;
    while (open < lines.length && !/\{\s*$/.test(lines[open])) open++;
    if (open >= lines.length) throw new Error(`${file}: no body opening brace for ${name}()`);

    let close = open + 1;
    while (close < lines.length && lines[close] !== "}") close++;
    if (close >= lines.length) throw new Error(`${file}: no closing brace at column 0 for ${name}()`);

    actions.push({ file, name, body: lines.slice(open + 1, close).join("\n") });
    i = close;
  }
  return actions;
}

let cached: { files: string[]; actions: ExportedAction[] } | undefined;

/** Memoized so the scan runs once, but inside a test — not at collection time. */
function scan(): { files: string[]; actions: ExportedAction[] } {
  if (!cached) {
    const files = serverActionFiles();
    cached = { files, actions: files.flatMap(exportedActions) };
  }
  return cached;
}

describe("admin server actions — assertAdminSession is structurally required", () => {
  it("discovers the server-action modules and their exported actions", () => {
    const { files, actions } = scan();
    expect(files.length).toBeGreaterThanOrEqual(MIN_SERVER_ACTION_FILES);
    expect(actions.length).toBeGreaterThanOrEqual(MIN_EXPORTED_ACTIONS);
  });

  it("rejects action declarations the scan cannot see", () => {
    // The complement of the invariant below: that one checks every action the
    // scan FINDS, this one checks that nothing privileged escapes the finding.
    // Without it a differently-declared export is skipped in silence and no
    // count drops, so every other case in this file still passes.
    const { files } = scan();

    const invisible: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const { pattern, form } of INVISIBLE_ACTION_FORMS) {
        for (const match of source.matchAll(pattern)) {
          invisible.push(`${file} → ${match[1] ?? "default"}  (${form})`);
        }
      }
    }

    expect(
      invisible,
      `Export(s) in a \`"use server"\` module declared in a form this file's ` +
        `scan cannot see, so the assertAdminSession invariant would skip them ` +
        `silently:\n  ${invisible.join("\n  ")}\n\n` +
        `Fix: declare it as \`export async function <name>(…)\` so the guard ` +
        `can see it, with \`await ${GUARD}();\` as its first statement. Do not ` +
        `teach this file the other form — one recognised declaration form is ` +
        `what makes the invariant cheap to keep true.`
    ).toEqual([]);
  });

  it("gates every exported action that is not ungated by design", () => {
    const { actions } = scan();

    const ungated = actions
      .filter((action) => !UNGATED_BY_DESIGN.includes(action.name))
      .filter((action) => !GUARD_CALL.test(action.body))
      .map((action) => `${action.file} → ${action.name}()`);

    expect(
      ungated,
      `Privileged server action(s) with no \`await ${GUARD}()\` in the body:\n` +
        `  ${ungated.join("\n  ")}\n\n` +
        `A server action is invoked by POSTing its action id to ANY path — including ` +
        `the ones proxy.ts allow-lists, such as /admin/login — so the route gate does ` +
        `NOT protect it. Fix: add \`await ${GUARD}();\` as the first statement of the ` +
        `function. If it is genuinely meant to be callable without a session, add its ` +
        `name to UNGATED_BY_DESIGN in this file together with the reason.`
    ).toEqual([]);
  });

  it("states its exceptions: each UNGATED_BY_DESIGN name is a real, genuinely ungated action", () => {
    // The allowlist is the verdict that SILENCES the invariant, so it gets its
    // own pin. Without this, renaming or deleting `login`/`logout` would leave a
    // stale entry behind, quietly excusing any future action that happens to
    // inherit the name.
    const { actions } = scan();

    for (const name of UNGATED_BY_DESIGN) {
      const action = actions.find((candidate) => candidate.name === name);
      expect(
        action,
        `UNGATED_BY_DESIGN names "${name}", which is no longer an exported server ` +
          `action. Remove the stale entry rather than leaving it to excuse a future one.`
      ).toBeDefined();
      expect(
        GUARD_CALL.test(action?.body ?? ""),
        `"${name}" now calls ${GUARD}, so its exception is obsolete — drop it from ` +
          `UNGATED_BY_DESIGN so the invariant covers it.`
      ).toBe(false);
    }
  });

  it("extracts one body per action, not a run-on of the whole file", () => {
    // Keeps `exportedActions` honest: an over-greedy body would inherit a
    // sibling's guard call and make the invariant above impossible to fail.
    const { actions } = scan();
    const submissions = actions.filter((action) =>
      action.file.endsWith(join("submissions", "actions.ts"))
    );

    expect(submissions.map((action) => action.name)).toEqual([
      "approveSubmissionAction",
      "rejectSubmissionAction",
    ]);
    expect(submissions[0].body).not.toContain("rejectSubmissionAction");
    expect(submissions[1].body).not.toContain("approveSubmissionAction");
  });
});
