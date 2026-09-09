/**
 * Shared MapLibre GL setup for every consumer that renders a
 * react-map-gl/maplibre <Map>: facility-map.tsx (/map),
 * hero-globe.tsx (homepage), and facility-mini-map.tsx (per-facility page).
 *
 * Why this module exists (GitHub issue #236 / PR #253, enforcing CSP with no
 * `'unsafe-eval'` — see next.config.ts's CSP directives): on maplibre-gl v5,
 * the standard entry point required a separate CSP-safe build to avoid
 * `script-src 'unsafe-eval'` violations. As of maplibre-gl v6, that split
 * build no longer exists — v6 dropped `new Function`/`eval` from the standard
 * bundle entirely, so the ESM-only standard entry point is CSP-safe on its
 * own (per MapLibre's official v5→v6 migration guide).
 *
 * What v6 still requires explicitly: the worker no longer runs from an
 * inlined blob URL, but from a real file, so `setWorkerUrl` must point at one.
 * It is served from `public/maplibre/` rather than referenced as a bundled
 * asset (`new URL(..., import.meta.url)`): v6's worker module opens with a
 * relative import of its `maplibre-gl-shared.mjs` sibling, and Next emits the
 * worker verbatim under a content-hashed name without rewriting that import,
 * so the worker requests a path that does not exist, 404s, and never boots —
 * the style then never loads and the basemap renders blank with no error.
 * `public/maplibre/` is a generated, gitignored copy written at build time
 * from the installed package by `scripts/copy-maplibre-worker.mjs` (wired to
 * `prebuild` and `predev` in package.json), so it cannot drift out of sync
 * with the installed maplibre-gl version on an upgrade.
 *
 * Two honest limits of that arrangement. The worker URL below is root-absolute,
 * so it assumes no `basePath`/`assetPrefix` is configured; if either is ever set,
 * this path needs the same prefix. And because the copy is wired to `predev` /
 * `prebuild`, invoking `next dev` / `next build` directly rather than through
 * `npm run dev` / `npm run build` skips it and the worker 404s again, with
 * nothing to catch it — always go through the npm scripts. `e2e/map-style.spec.ts`
 * does not cover that bypass: its `webServer.command` is `npm run build`, so it
 * runs `prebuild` itself. What it does cover is the symptom class, in a build it
 * started — on `/` and `/map` it asserts `isStyleLoaded()` becomes true and that
 * no response whose URL contains "maplibre" returned >= 400.
 *
 * Every consumer MUST import `mapLib` from here rather than importing
 * `maplibre-gl` directly: `@vis.gl/react-maplibre`'s `reuseMaps` pool
 * (`Maplibre.savedMaps`, a single static array) is shared across every
 * `<Map reuseMaps>` in the app regardless of which mapLib instance built the
 * pooled entry — mixing separately-constructed maplibregl instances across
 * consumers would let a pooled instance from one built at consumer A reach
 * consumer B unexpectedly. Importing this one module everywhere keeps every
 * pooled instance identical. See facility-mini-map.tsx for why that map
 * deliberately does NOT pass `reuseMaps` — the same pool.
 */
import * as maplibregl from "maplibre-gl";

maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

/** Pass to every `<Map mapLib={mapLib}>` in this app — see module doc above. */
export const mapLib = maplibregl;
