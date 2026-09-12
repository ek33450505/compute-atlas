# Wave coordinate gates

Two gate scripts that check a data wave's proposed facility coordinates
against independent evidence before those candidates go to review. They were
first written ad hoc inside a `wave-*/` scratch directory (gitignored, so they
vanished with the folder at the end of each wave) after the 2026-09-12 MA
discovery agent honestly reported geocoding seven records "using my own
geographic knowledge" of the corporate parks involved — checked against the
Census geocoder, those pins were 1.2–4.4 km from their own stated address,
every one carrying `precision: "approximate"` (true, and uninformative). Model
recall is not a geocoder. These scripts are.

Neither script touches `data/` or the live dataset — they operate only on a
wave's own `*-discovery.json` artifacts, before anything reaches
`submissions` or `db:sync`.

## Usage

Both scripts require `--dir=<path>`, resolved relative to the current working
directory. This is deliberate: a gate that silently falls back to a guessed
or stale directory reports a clean run over nothing, which is worse than not
running at all. Omitting it prints a usage line and exits 1.

```bash
node scripts/wave/geo-check.mjs --dir=wave-2026-09-12 [--fix] [--only=STATE]
node scripts/wave/osm-crosscheck.mjs --dir=wave-2026-09-12 [--only=STATE]
```

- `--only=MA` restricts either script to artifacts whose filename contains
  the given string. Useful because a wave's agents finish at different
  times, and `geo-check --fix` rewrites files — running unfiltered while a
  sibling agent is still flushing its own artifact is a lost-update race
  between two writers.
- `geo-check.mjs --fix` rewrites failing/warning pins in place and appends an
  entry to `<dir>/geo-corrections.json` (before/after coordinates, distance
  moved, and the matched address) so every correction stays reviewable and
  reversible.
- `<dir>/geo-adjudicated.json` holds ids a human has already pinned to a
  higher-authority source (see below). `geo-check --fix` reports these but
  never rewrites them — without this list, a future `--fix` run would
  quietly revert an adjudicated pin back to Census, indistinguishable in the
  log from a routine correction.

## Coordinate authority, in order

1. **A coordinate stated by the source itself.** Highest authority — but a
   page can carry two pairs (e.g. a parent campus and a specific building),
   so use the one actually anchored to the address string being cited, not
   just any coordinate found on the page.
2. **An OSM-mapped building at the address** (`osm-crosscheck.mjs`, VERIFY
   mode — a record with a `location.street`). A small delta from OSM's
   building footprint is real corroboration.
3. **The US Census geocoder** (`geo-check.mjs`). Authoritative for US street
   addresses and free, but it interpolates along street centre lines rather
   than resolving to a building footprint — measured 1.9 km off at a real
   address. Good enough to correct a multi-km recall error; not perfect
   ground truth.
4. **A city centroid**, disclosed as such in the record's `notes`. The
   fallback when nothing more specific is available — never assert this
   silently as a facility-level pin.

## Why `geo-check --fix` moves the pin toward the address, never the reverse

A record's `location.street` came from a fetched, cited source. Its
`location.lat`/`lon` often did not — it came from an agent's recall of the
area. When the two disagree, the address is the trustworthy half of the
pair, so the fix always moves the coordinate to match the address; it never
adjusts the address to match an existing coordinate.

Census is not infallible here — it interpolates, and it has been measured
1.9 km from a source-stated coordinate that sat 29 m from the mapped
building (`iron-mountain-nje1-edison-nj`). What makes `--fix` safe to
automate is not the geocoder's accuracy but the two things around it: a
multi-km recall error is worse than interpolation slop, and any pin already
adjudicated to a higher authority is listed in `geo-adjudicated.json` and
never rewritten. Every rewrite also lands in `geo-corrections.json` with its
prior value, so a wrong correction is reviewable and reversible.

## Why `osm-crosscheck` only reports

`osm-crosscheck.mjs`'s authority (Nominatim) does not have that same
property: a street query with no exact match will happily return the town
centroid instead of failing closed. Auto-correcting toward that would
manufacture false precision — the exact failure this whole check exists to
catch. So `osm-crosscheck.mjs` only ever reports (`corroborated` /
`needs-a-human` / `inconclusive`) and never writes; a human decides what to
do with a `needs-a-human` or `inconclusive` result.

## Measured result

The 2026-09-12 wave is the reason these scripts exist. Running `geo-check.mjs`
against all 65 staged records corrected 17 pins, moving them 47.8 cumulative
km closer to their own stated addresses. The gap was concentrated in one
agent: checked against the Census geocoder, none of its seven hand-recalled
pins landed within 500 m of their own stated address (errors of 1.2, 2.8,
3.3, 3.3, 3.7 and 4.4 km), while a sibling agent working the same wave under
the same instructions queried OSM Nominatim for every address instead and
landed every pin within 140 m. Same contract, opposite outcomes — recall is
not a substitute for a geocoder call.
