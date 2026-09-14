import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import noInternalCodenames from "./eslint-rules/no-internal-codenames.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Internal development codenames in comments were stripped by hand once
    // (~50 files) and came back within nine days of ordinary feature work,
    // because the convention lives in a doc nobody re-reads while writing a
    // comment. The rule's own header carries the full rationale and the
    // deliberate line between an unresolvable codename and a public PR
    // reference. Errors, not warnings: a warning in a suite this size is a
    // line nobody reads.
    plugins: { local: { rules: { "no-internal-codenames": noInternalCodenames } } },
    rules: {
      "local/no-internal-codenames": "error",
    },
  },
  {
    // `sendGroupedChangeNotifications` (lib/notify.ts) is exported ONLY so
    // lib/notify.test.ts can drive its mixed-state guard directly with a
    // synthetic mixed-state group — see that export's own doc comment. Every
    // real caller goes through notifySubscribersOfChange(s) /
    // notifyStateSubscribersMonthly, which build groups the guard can never
    // actually trip. A production import would defeat that guard silently
    // (a mislabelled, cross-state digest sharing one unsubscribe token,
    // unsubscribing a reader from a state they never chose to leave) instead
    // of loudly, so this is enforced mechanically rather than left to the doc
    // comment alone.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/notify",
              importNames: ["sendGroupedChangeNotifications"],
              message:
                "sendGroupedChangeNotifications is exported for lib/notify.test.ts only — no production caller outside lib/notify.ts. Use notifySubscribersOfChange(s) or notifyStateSubscribersMonthly instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // The rule's own definition and its RuleTester fixtures are the one place
    // where a codename IS the subject rather than a leak: the header documents
    // the convention by example, and the test must feed the rule real
    // violations to prove it bites. Exempting the pair is narrower than
    // sprinkling eslint-disable lines through either, and it keeps the two
    // files that define the convention readable as prose.
    files: [
      "eslint-rules/no-internal-codenames.mjs",
      "eslint-rules/no-internal-codenames.test.mjs",
    ],
    rules: {
      "local/no-internal-codenames": "off",
    },
  },
  {
    // The definition itself and its one legitimate test consumer are exempt
    // from the restriction above.
    files: ["lib/notify.ts", "lib/notify.test.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scratchpad/**",
    // Minified maplibre-gl worker bundles copied verbatim from node_modules by
    // scripts/copy-maplibre-worker.mjs (see .gitignore). Vendored third-party
    // output, not source — linting it produced ~1100 warnings of pure noise.
    "public/maplibre/**",
    // Per-wave research scratch dirs (see .gitignore). Throwaway working
    // artifacts from data waves, not application source — gitignoring them
    // does not stop ESLint, which walks the filesystem rather than git.
    "wave-*/**",
  ]),
]);

export default eslintConfig;
