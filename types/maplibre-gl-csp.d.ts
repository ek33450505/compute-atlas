/**
 * `maplibre-gl` ships a separate CSP-safe entry point
 * (`dist/maplibre-gl-csp.js`, see lib/maplibre-csp.ts) that has no `.d.ts`
 * of its own — it's the identical public API as the standard `maplibre-gl`
 * entry, just built without the eval path (and without an inlined worker),
 * so re-export the main package's types for this subpath rather than typing
 * it from scratch. `maplibre-gl`'s package.json has no `exports` map
 * restricting subpath imports, so this deep import resolves fine at both
 * the type-checker and bundler level.
 */
declare module "maplibre-gl/dist/maplibre-gl-csp" {
  export * from "maplibre-gl";
}
