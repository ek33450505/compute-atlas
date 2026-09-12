import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
