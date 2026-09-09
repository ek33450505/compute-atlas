#!/usr/bin/env node
/**
 * Copy MapLibre GL's worker bundle into public/maplibre/ so it can be served
 * as a plain static asset.
 *
 * Why this exists: maplibre-gl v6 ships its worker as an ES module whose first
 * line imports a sibling, `./maplibre-gl-shared.mjs`. If the worker is emitted
 * by the bundler (e.g. `new URL("maplibre-gl/dist/maplibre-gl-worker.mjs",
 * import.meta.url)`), Next copies the file verbatim under a content-hashed name
 * but does not rewrite that relative import, so the worker requests a path that
 * does not exist, 404s, and never boots — the basemap then renders blank with
 * no error. Copying both files together preserves the sibling relationship the
 * import needs.
 *
 * Wired to `prebuild` and `predev` in package.json, so the copy is always
 * regenerated from the installed package and cannot drift from the installed
 * maplibre-gl version. `public/maplibre/` is gitignored.
 */

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BLANK_BASEMAP_WARNING =
  "[copy-maplibre-worker] The MapLibre worker cannot be served, which renders the basemap blank at runtime. Refusing to continue.";

// maplibre-gl v6's `exports` map exposes "./package.json", so resolving it is a
// stable way to find the installed package rather than hardcoding node_modules.
let packageJsonPath;
try {
  packageJsonPath = require.resolve("maplibre-gl/package.json");
} catch {
  console.error(
    "[copy-maplibre-worker] Could not resolve maplibre-gl — dependencies are probably not installed (run `npm install`)."
  );
  console.error(BLANK_BASEMAP_WARNING);
  process.exit(1);
}

const distDir = join(dirname(packageJsonPath), "dist");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

const destDir = join(projectRoot, "public", "maplibre");

const missing = FILES.filter((name) => !existsSync(join(distDir, name)));
if (missing.length > 0) {
  console.error(
    `[copy-maplibre-worker] Missing expected file(s) in ${distDir}: ${missing.join(", ")}`
  );
  console.error(BLANK_BASEMAP_WARNING);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

for (const name of FILES) {
  const from = join(distDir, name);
  const to = join(destDir, name);
  copyFileSync(from, to);
  const { size } = statSync(to);
  console.log(`[copy-maplibre-worker] ${name} → public/maplibre/${name} (${size} bytes)`);
}

// The `existsSync` guard above proves FILES exist; it never proves they are
// *sufficient*. If a future maplibre-gl adds a third sibling import to the
// worker, copying only these two would leave that sibling 404ing and reproduce
// the exact blank basemap this script exists to prevent — silently, on a zero
// exit. So read the copies back and refuse any relative import we did not copy.
// Matches `from "./x"`, side-effect `import "./x"`, dynamic `import("./x")` and
// the template-literal form import(`./x`) — the quote set is ", ' and backtick,
// so a bundle switching to backticks cannot slip past this guard silently.
const SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g;

const unresolved = new Set();
for (const name of FILES) {
  const source = readFileSync(join(destDir, name), "utf8");
  for (const [, specifier] of source.matchAll(SPECIFIER_RE)) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    // Drop any ?query / #hash suffix and the leading "./" so the result is
    // comparable against FILES, which are bare filenames. A "../" specifier
    // never normalises into FILES, and is correctly reported: it points outside
    // the directory we copy into.
    const target = specifier.split(/[?#]/, 1)[0].replace(/^\.\//, "");
    if (!FILES.includes(target)) unresolved.add(`${name} imports ${specifier}`);
  }
}

if (unresolved.size > 0) {
  console.error(
    `[copy-maplibre-worker] Copied file(s) import sibling module(s) that were not copied: ${[...unresolved].join("; ")}`
  );
  console.error(BLANK_BASEMAP_WARNING);
  console.error(
    `[copy-maplibre-worker] Add the missing sibling(s) to FILES in ${"scripts/copy-maplibre-worker.mjs"} and re-run.`
  );
  process.exit(1);
}

console.log(`[copy-maplibre-worker] Copied ${FILES.length} file(s) from ${distDir}`);
