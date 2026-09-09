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
 * inlined blob URL, but from a real file (`maplibre-gl/dist/maplibre-gl-worker.mjs`),
 * so bundler consumers (webpack/Turbopack, per this app's `next build`) must
 * still point `setWorkerUrl` at it. `new URL(..., import.meta.url)` is a
 * build-time-resolved asset reference that both webpack and Turbopack
 * recognize, emitting the target as a bundled static asset with a
 * content-hashed production URL — this survives a production build without
 * a hand-maintained copy of the worker file under public/ that could drift
 * out of sync with the installed maplibre-gl version on an upgrade.
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

maplibregl.setWorkerUrl(
  new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href
);

/** Pass to every `<Map mapLib={mapLib}>` in this app — see module doc above. */
export const mapLib = maplibregl;
