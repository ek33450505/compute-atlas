/**
 * Forbids internal development codenames in source comments.
 *
 * The convention this enforces was applied by hand once (commit `14705bb`,
 * ~50 files) and its criterion is stated there: strip
 * "codenames that outside contributors cannot resolve", keeping every
 * constraint sentence, measured number, and date. The comment survives; only
 * the tag naming a private milestone goes.
 *
 * Why a rule and not another sweep. Nine days after that sweep, ~11 fresh
 * instances had appeared in ordinary feature work, and a later audit found
 * more. The comments are written by whoever is closest to the work, at the
 * moment the private context feels like shared context — which is exactly
 * when nobody re-reads a convention doc. A one-time sweep resets the clock;
 * only a gate stops the clock.
 *
 * What counts as unresolvable, and what deliberately does NOT:
 *
 *   BLOCKED   session codenames (`s65`), milestone tags (`Phase 1c`,
 *             `Track 2`, `Unit 3`, `SEO-Task 4`). A reader outside this
 *             machine has no artifact to look these up in — not the repo,
 *             not the issue tracker, not the git history.
 *
 *   ALLOWED   `PR #304`, `issue #236`, and bare `#253`. These resolve on a
 *             PUBLIC GitHub repo: anyone can open the PR and read the
 *             reasoning the comment is pointing at. They are provenance, not
 *             codenames, and stripping them would delete the one thing that
 *             makes a terse comment checkable. This is a deliberate
 *             narrowing of the backlog note that counted them as violations
 *             — flagged for the maintainer rather than decided silently.
 *
 * Escape hatch: the standard one.
 *
 *   // eslint-disable-next-line local/no-internal-codenames -- <why>
 *
 * Use it when the codename IS the subject (documenting the convention
 * itself), never to keep a tag that a rewritten sentence could carry.
 */

/**
 * Each pattern is anchored on both sides against word characters so a
 * codename must stand alone. Without the lookarounds `s65` matches inside
 * identifiers and hashes — `things65`, `0fs65a` — and the rule becomes noise
 * that gets disabled wholesale, which is worse than no rule.
 *
 * `s\d{2,3}` deliberately requires two digits: `s3` is an AWS bucket far more
 * often than it is a session, and a rule that flags `S3` in a comment about
 * object storage would be wrong on its first real encounter.
 */
const PATTERNS = [
  {
    label: "session codename",
    regex: /(?<![A-Za-z0-9_])s\d{2,3}(?![A-Za-z0-9_])/g,
  },
  {
    label: "milestone tag",
    regex: /(?<![A-Za-z0-9_])(?:Phase|Track|Unit)\s+\d+[a-z]?(?![A-Za-z0-9_])/g,
  },
  {
    label: "task tag",
    regex: /(?<![A-Za-z0-9_])SEO-Task\s*\d+(?![A-Za-z0-9_])/g,
  },
];

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow internal development codenames (session numbers, milestone tags) in comments",
    },
    schema: [],
    messages: {
      internalCodename:
        '"{{match}}" is an internal {{label}} that a reader outside this repo cannot resolve. Keep the sentence and drop the tag — or name the thing itself (a date, a measured number, a PR number, a file path). See eslint-rules/no-internal-codenames.mjs.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          for (const { label, regex } of PATTERNS) {
            // Defensive only, and deliberately kept despite that: a /g
            // regex whose exec() loop runs to exhaustion already resets its
            // own lastIndex to 0 when the final call returns null, so with
            // the loop below written as it is, deleting this line changes
            // nothing. Mutation-testing confirmed it — removing it failed no
            // test, because there is no reachable state where it matters.
            //
            // It earns its place against ONE specific future edit: the
            // moment anyone adds an early `break` (a per-comment report cap,
            // a short-circuit on the first match), the loop stops leaving
            // lastIndex mid-string, and the NEXT comment silently starts
            // scanning from that offset — skipping real violations with no
            // error anywhere. That failure is invisible; this line is one
            // token. Do not "simplify" it away without re-reading the loop.
            regex.lastIndex = 0;

            let match;
            while ((match = regex.exec(comment.value)) !== null) {
              // comment.value excludes the delimiters, so offset by the
              // opening "//" or "/*" to land the caret on the codename.
              const start = comment.range[0] + 2 + match.index;

              context.report({
                loc: {
                  start: sourceCode.getLocFromIndex(start),
                  end: sourceCode.getLocFromIndex(start + match[0].length),
                },
                messageId: "internalCodename",
                data: { match: match[0], label },
              });
            }
          }
        }
      },
    };
  },
};

export default rule;
