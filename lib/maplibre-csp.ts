/**
 * Shared CSP-safe MapLibre GL setup for every consumer that renders a
 * react-map-gl/maplibre <Map>: facility-map.tsx (/map),
 * hero-globe.tsx (homepage), and facility-mini-map.tsx (per-facility page).
 *
 * Why: the standard `maplibre-gl` entry point compiles style expressions
 * with `new Function`, which trips `script-src` under an enforcing CSP with
 * no `'unsafe-eval'` (see next.config.ts's CSP_REPORT_ONLY_DIRECTIVES —
 * script-src deliberately omits 'unsafe-eval'). `dist/maplibre-gl-csp.js`
 * is the package's own CSP-safe build for exactly this case (GitHub issue
 * #236); it was previously unused, leaving `/map` as the sole route family
 * still producing a CSP violation (`directive="script-src"
 * blockedURI="eval"`) in e2e/csp.spec.ts.
 *
 * The CSP build doesn't inline its worker bundle (that's the other half of
 * what makes it CSP-safe — no worker created via a stringified-source blob
 * URL), so it has to be told explicitly where to fetch the worker script.
 * `new URL(..., import.meta.url)` is a build-time-resolved asset reference
 * — both webpack (this app's build, see next.config.ts / package.json's
 * `next build`) and Turbopack recognize this exact form and emit the target
 * as a bundled static asset with a content-hashed production URL, so this
 * survives a production build without a hand-maintained copy of the worker
 * file under public/ that could drift out of sync with the installed
 * maplibre-gl version on an upgrade.
 *
 * Every consumer MUST import `mapLib` from here rather than importing
 * `maplibre-gl` directly: `@vis.gl/react-maplibre`'s `reuseMaps` pool
 * (`Maplibre.savedMaps`, a single static array) is shared across every
 * `<Map reuseMaps>` in the app regardless of which mapLib built the pooled
 * instance — mixing the standard and CSP builds across consumers would let
 * a pooled standard-build instance (still eval-based) reach /map, or a
 * pooled CSP-build instance reach a consumer that never set its worker URL.
 * Importing this one module everywhere keeps every pooled instance
 * identical. See facility-mini-map.tsx for why that map deliberately does
 * NOT pass `reuseMaps` — the same pool.
 */
import * as maplibregl from "maplibre-gl/dist/maplibre-gl-csp";

maplibregl.setWorkerUrl(
  new URL("maplibre-gl/dist/maplibre-gl-csp-worker.js", import.meta.url).href
);

/** Pass to every `<Map mapLib={mapLib}>` in this app — see module doc above. */
export const mapLib = maplibregl;
