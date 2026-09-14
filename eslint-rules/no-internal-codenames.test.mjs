import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "./no-internal-codenames.mjs";

// RuleTester calls global describe/it; vitest runs with globals: true, but this
// file imports them explicitly so the binding is visible rather than ambient.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const codename = (match, label) => ({
  messageId: "internalCodename",
  data: { match, label },
});

ruleTester.run("no-internal-codenames", rule, {
  valid: [
    // --- The deliberate carve-out: publicly resolvable provenance ---------
    // These are the reason the rule is not simply "no #NNN in comments". On a
    // public repo each of these is a link a stranger can follow, which is the
    // opposite of the problem being solved. If a future edit widens the
    // patterns to cover them, these cases fail and say so.
    "// Regression coverage for the bug fixed in PR #170",
    "// Why this module exists (GitHub issue #236 / PR #253)",
    "// reproduces the incident directly (#222)",

    // --- Near-misses that must NOT trip ----------------------------------
    // One digit: S3 is object storage far more often than a session.
    "// Uploads go to the s3 bucket",
    "// Uploads go to the S3 bucket",
    // Embedded in a longer token — the lookarounds exist for exactly this.
    "// hash prefix 0fs65a is not a codename",
    "// the things65 identifier",
    // Four digits runs past the pattern rather than matching its prefix.
    "// port s6000 is not a session",
    // A bare number with no s- prefix.
    "// 65 sites tracked",
    // Lowercase prose, no digit-tag shape.
    "// run this in a second phase, once the backfill lands",
    // Code is not a comment: the rule reads comments only, so a variable
    // named for a milestone is out of scope by design (renaming is a
    // different, riskier change than rewording a sentence).
    "const phase1c = true;",
    "const s65 = 1;",
    // A string literal that merely mentions one.
    'const msg = "shipped in s65";',
  ],

  invalid: [
    {
      code: "// Scheduled to run AFTER the response is sent (s65 security review)",
      errors: [codename("s65", "session codename")],
    },
    {
      code: "// motion-reduce gating (s59)",
      errors: [codename("s59", "session codename")],
    },
    {
      code: "/* Full-bleed layout (Phase 1c): meets the viewport edges */",
      errors: [codename("Phase 1c", "milestone tag")],
    },
    {
      code: "// the field-extraction lane (Track 2)",
      errors: [codename("Track 2", "milestone tag")],
    },
    {
      code: "// recorded by the Unit 2 POST handler",
      errors: [codename("Unit 2", "milestone tag")],
    },
    {
      code: "// title rewrite (SEO-Task 4)",
      errors: [codename("SEO-Task 4", "task tag")],
    },
    {
      // Two different pattern families in one comment must both report —
      // a single comment is not a single violation. The real instance this
      // mirrors read "(s59 Unit 2)".
      code: "// gating (s59 Unit 2)",
      errors: [
        codename("s59", "session codename"),
        codename("Unit 2", "milestone tag"),
      ],
    },
    {
      // Two matches of the SAME pattern in one comment — the exec() loop
      // must keep going rather than report the first and stop.
      //
      // ⚠️ This does NOT cover the lastIndex reset in the rule, though an
      // earlier version of this comment claimed it did. Mutation-testing
      // showed deleting that line fails nothing: an exhausted /g exec() loop
      // resets lastIndex itself. The reset guards a future early `break`,
      // which no test can reach today. Recorded rather than quietly dropped,
      // because a comment asserting coverage that does not exist is worse
      // than no comment.
      code: "// see s59 and also s60 for the earlier attempt",
      errors: [
        codename("s59", "session codename"),
        codename("s60", "session codename"),
      ],
    },
    {
      // Block comments are reported too, and at the right place — the
      // reported column is computed by hand from the comment's range, so it
      // is arithmetic that can be wrong without any test noticing. It caught
      // me: I asserted 14 here first and the rule was right, not the test.
      // Counting the literal, "s" of "s65" in `/* fixed in s65 */` is the
      // 13th character (1-indexed).
      code: "/* fixed in s65 */",
      errors: [
        {
          ...codename("s65", "session codename"),
          line: 1,
          column: 13,
          endColumn: 16,
        },
      ],
    },
    {
      // Same check for a line comment, whose delimiter is also two
      // characters — a rule that hardcoded the wrong offset for one form
      // would pass the other.
      code: "// fixed in s65",
      errors: [
        {
          ...codename("s65", "session codename"),
          line: 1,
          column: 13,
          endColumn: 16,
        },
      ],
    },
    {
      // A codename on a later line reports on that line, not line 1.
      code: "const a = 1;\n// shipped in s65\nconst b = 2;",
      errors: [{ ...codename("s65", "session codename"), line: 2 }],
    },
  ],
});
