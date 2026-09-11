import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
