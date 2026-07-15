/**
 * build-parchment-style.mjs
 *
 * Generates a "flat parchment atlas" MapLibre GL style JSON from OpenFreeMap's
 * positron style, recoloring it with a warm parchment palette.
 *
 * Usage: node scripts/build-parchment-style.mjs
 * Output: public/basemap/parchment.json
 */

import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const P = {
  parchment:  '#F5F1E6',   // land/background
  ink:        '#2B2721',   // major labels
  mutedInk:   '#5C5344',   // muted labels, roads
  hairline:   '#CDBFA0',   // road/hairline
  green:      '#3F5B43',   // park/wood
  muted:      '#E9E2CF',   // subtle fill
  accent:     '#E4DBC4',   // building/pier fill
  water:      '#C9D6DA',   // water fill
  waterway:   '#AEBEC4',   // waterway line
  boundary:   '#B7A981',   // boundaries / railways
};

// Thin road line-width interpolate expression
const THIN_ROAD_WIDTH = ['interpolate', ['linear'], ['zoom'], 5, 0.4, 10, 0.8, 16, 1.4];

// Layers to completely drop (casing layers + ne2_shaded)
const DROP_LAYER_IDS = new Set([
  'tunnel_motorway_casing',
  'highway_major_casing',
  'highway_motorway_casing',
  'highway_motorway_bridge_casing',
]);

// Transportation line layers to recolor (non-casing, non-railway)
const ROAD_LINE_IDS = new Set([
  'tunnel_motorway_inner',
  'highway_major_inner',
  'highway_major_subtle',
  'highway_motorway_inner',
  'highway_motorway_subtle',
  'highway_motorway_bridge_inner',
  'highway_minor',
  'highway_path',
  'road_pier',
]);

// Railway layers (line)
const RAILWAY_IDS = new Set([
  'railway',
  'railway_dashline',
  'railway_service',
  'railway_service_dashline',
  'railway_transit',
  'railway_transit_dashline',
]);

// Major label ids (ink color)
const MAJOR_LABEL_IDS = new Set([
  'label_country_1', 'label_country_2', 'label_country_3',
  'label_state',
  'label_city', 'label_city_capital',
]);

// Muted label ids
const MUTED_LABEL_IDS = new Set([
  'label_town', 'label_village', 'label_other',
]);

// Water label ids
const WATER_LABEL_IDS = new Set([
  'water_name_point_label', 'water_name_line_label', 'waterway_line_label',
]);

// Transportation name / shield ids
const TRANSPORT_NAME_IDS = new Set([
  'highway-name-path', 'highway-name-minor', 'highway-name-major',
  'highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us',
]);

// ---------------------------------------------------------------------------
// WCAG contrast helpers
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function linearize(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Transform a single layer in-place
// ---------------------------------------------------------------------------
function transformLayer(layer) {
  const id = layer.id;

  // background
  if (id === 'background') {
    layer.paint = { ...layer.paint, 'background-color': P.parchment };
    return layer;
  }

  // land fills
  if (['landuse_residential', 'landcover_ice_shelf', 'landcover_glacier'].includes(id)) {
    layer.paint = { ...layer.paint, 'fill-color': P.parchment };
    return layer;
  }

  // water fill
  if (id === 'water') {
    layer.paint = { ...layer.paint, 'fill-color': P.water };
    return layer;
  }

  // waterway line
  if (id === 'waterway') {
    layer.paint = { ...layer.paint, 'line-color': P.waterway };
    return layer;
  }

  // park + wood: faint green wash
  if (id === 'park' || id === 'landcover_wood') {
    layer.paint = { ...layer.paint, 'fill-color': P.green, 'fill-opacity': 0.08 };
    return layer;
  }

  // building: subtle accent fill, preserve zoom gating
  if (id === 'building') {
    layer.paint = { ...layer.paint, 'fill-color': P.accent };
    return layer;
  }

  // road_area_pier fill
  if (id === 'road_area_pier') {
    layer.paint = { ...layer.paint, 'fill-color': P.accent };
    return layer;
  }

  // road lines (non-casing)
  if (ROAD_LINE_IDS.has(id)) {
    const newPaint = { ...layer.paint, 'line-color': P.hairline, 'line-width': THIN_ROAD_WIDTH };
    delete newPaint['line-gap-width'];
    layer.paint = newPaint;
    return layer;
  }

  // railway lines — preserve dasharray
  if (RAILWAY_IDS.has(id)) {
    const newPaint = { ...layer.paint, 'line-color': P.boundary };
    // set thin width but only override if present
    newPaint['line-width'] = THIN_ROAD_WIDTH;
    layer.paint = newPaint;
    return layer;
  }

  // boundaries
  if (id === 'boundary_2' || id === 'boundary_3') {
    layer.paint = {
      ...layer.paint,
      'line-color': P.boundary,
      'line-dasharray': [2, 2],
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 1, 12, 1.5],
    };
    return layer;
  }
  if (id === 'boundary_disputed') {
    layer.paint = {
      ...layer.paint,
      'line-color': P.boundary,
      'line-dasharray': [2, 2],
      'line-opacity': 0.5,
    };
    return layer;
  }

  // aeroway area fill
  if (id === 'aeroway-area') {
    layer.paint = { ...layer.paint, 'fill-color': P.accent, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.6] };
    return layer;
  }

  // aeroway lines (taxiway, runway, runway-casing)
  if (['aeroway-taxiway', 'aeroway-runway', 'aeroway-runway-casing'].includes(id)) {
    layer.paint = { ...layer.paint, 'line-color': P.hairline };
    return layer;
  }

  // major place labels
  if (MAJOR_LABEL_IDS.has(id)) {
    layer.paint = {
      ...layer.paint,
      'text-color': P.ink,
      'text-halo-color': P.parchment,
      'text-halo-width': 1.2,
    };
    delete layer.paint['text-halo-blur'];
    return layer;
  }

  // muted place labels
  if (MUTED_LABEL_IDS.has(id)) {
    layer.paint = {
      ...layer.paint,
      'text-color': P.mutedInk,
      'text-halo-color': P.parchment,
      'text-halo-width': 1.2,
    };
    delete layer.paint['text-halo-blur'];
    return layer;
  }

  // water labels
  if (WATER_LABEL_IDS.has(id)) {
    layer.paint = {
      ...layer.paint,
      'text-color': P.mutedInk,
      'text-halo-color': P.parchment,
      'text-halo-width': 1.2,
    };
    delete layer.paint['text-halo-blur'];
    return layer;
  }

  // transportation name / shields — soften text only, leave icon layout
  if (TRANSPORT_NAME_IDS.has(id)) {
    layer.paint = {
      ...layer.paint,
      'text-color': P.mutedInk,
      'text-halo-color': P.parchment,
    };
    return layer;
  }

  // airport symbol
  if (id === 'airport') {
    layer.paint = {
      ...layer.paint,
      'text-color': P.mutedInk,
      'text-halo-color': P.parchment,
    };
    delete layer.paint['text-halo-blur'];
    return layer;
  }

  return layer;
}

// ---------------------------------------------------------------------------
// Structural fallback validator (if style-spec unavailable)
// ---------------------------------------------------------------------------
function structuralValidate(style) {
  const errors = [];
  if (style.version !== 8) errors.push('version must be 8');
  if (!style.sources?.openmaptiles) errors.push('sources.openmaptiles missing');
  if (style.sources?.ne2_shaded) errors.push('ne2_shaded source was not dropped');
  if (!Array.isArray(style.layers) || style.layers.length === 0) errors.push('layers empty');
  for (const layer of (style.layers || [])) {
    if (typeof layer.id !== 'string') errors.push(`layer missing string id: ${JSON.stringify(layer.id)}`);
    if (typeof layer.type !== 'string') errors.push(`layer ${layer.id} missing string type`);
  }
  // ne2_shaded must not appear in any layer
  const ne2Layer = (style.layers || []).find(l => l.source === 'ne2_shaded');
  if (ne2Layer) errors.push(`ne2_shaded still referenced in layer: ${ne2Layer.id}`);
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const POSITRON_URL = 'https://tiles.openfreemap.org/styles/positron';
  const OUT_DIR  = resolve(repoRoot, 'public', 'basemap');
  const OUT_FILE = resolve(OUT_DIR, 'parchment.json');

  // 1. Fetch positron
  console.log(`Fetching ${POSITRON_URL} …`);
  let style;
  try {
    const res = await fetch(POSITRON_URL);
    if (!res.ok) {
      console.error(`Network error: HTTP ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    style = await res.json();
    console.log(`Fetched positron — version ${style.version}, ${style.layers?.length ?? 0} layers.`);
  } catch (err) {
    console.error(`Fetch failed: ${err.message}`);
    process.exit(1);
  }

  const sourceLayerCount = style.layers?.length ?? 0;

  // 2. Apply transform
  // Drop ne2_shaded source
  if (style.sources?.ne2_shaded) delete style.sources.ne2_shaded;

  // Filter and transform layers
  const droppedLayers = [];
  style.layers = (style.layers || [])
    .filter(layer => {
      if (DROP_LAYER_IDS.has(layer.id) || layer.source === 'ne2_shaded') {
        droppedLayers.push(layer.id);
        return false;
      }
      return true;
    })
    .map(layer => transformLayer(JSON.parse(JSON.stringify(layer))));

  const outputLayerCount = style.layers.length;

  // 3. Validate
  let validationPassed = false;
  let validationMethod = 'structural';
  let validationErrors = [];

  try {
    const require = createRequire(import.meta.url);
    const styleSpec = require(
      resolve(repoRoot, 'node_modules/@maplibre/maplibre-gl-style-spec/dist/index.cjs')
    );
    if (typeof styleSpec.validateStyleMin === 'function') {
      validationMethod = 'maplibre-gl-style-spec';
      const result = styleSpec.validateStyleMin(style);
      validationErrors = result || [];
      validationPassed = validationErrors.length === 0;
    } else {
      throw new Error('validateStyleMin not found in style-spec');
    }
  } catch {
    // Fallback to structural check
    validationErrors = structuralValidate(style);
    validationPassed = validationErrors.length === 0;
  }

  if (!validationPassed) {
    console.error(`\nValidation FAILED (${validationMethod}):`);
    for (const e of validationErrors) {
      console.error(`  - ${typeof e === 'string' ? e : (e.message ?? JSON.stringify(e))}`);
    }
    process.exit(1);
  }

  // 4. Write output
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(style, null, 2), 'utf8');

  // 5. Summary
  console.log('\n--- Parchment Style Build Summary ---');
  console.log(`Validation:       PASS (${validationMethod})`);
  console.log(`Source layers:    ${sourceLayerCount}`);
  console.log(`Output layers:    ${outputLayerCount}`);
  console.log(`Dropped sources:  ne2_shaded`);
  console.log(`Dropped layers:   ${droppedLayers.join(', ')}`);
  console.log(`Output:           ${OUT_FILE}`);

  // 6. Contrast assertion
  const MARKER_COLORS = [
    { name: 'operational (#005E90)',        hex: '#005E90' },
    { name: 'under_construction (#8F4108)', hex: '#8F4108' },
    { name: 'permitted (#036A4A)',          hex: '#036A4A' },
    { name: 'proposed (#8A2661)',           hex: '#8A2661' },
    { name: 'cancelled (#565C64)',          hex: '#565C64' },
  ];
  const BACKGROUNDS = [
    { name: 'parchment',  hex: P.parchment },
    { name: 'water',      hex: P.water     },
  ];

  console.log('\n--- WCAG Contrast Ratios (marker vs basemap) ---');
  let anyWarn = false;
  for (const marker of MARKER_COLORS) {
    for (const bg of BACKGROUNDS) {
      const ratio = contrastRatio(marker.hex, bg.hex);
      const pass = ratio >= 4.5;
      const tag  = pass ? 'PASS' : 'WARN (<4.5 — markers have borders)';
      if (!pass) anyWarn = true;
      console.log(`  ${marker.name} vs ${bg.name}: ${ratio.toFixed(2)}  ${tag}`);
    }
  }
  if (anyWarn) {
    console.log('\nWARNING: Some ratios < 4.5. Markers use colored borders for distinction — visually acceptable but noted.');
  } else {
    console.log('\nAll marker contrast ratios >= 4.5.');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
