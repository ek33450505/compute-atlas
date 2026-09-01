# Methodology

How Compute Atlas finds facilities, what standard each record is held to, and
how to read the sources behind a record. This is the reference behind the
short ["How the data is built"](../README.md#how-the-data-is-built) summary in
the README. It complements two other docs: [`CONTRIBUTING.md`](../CONTRIBUTING.md)
(how to add or correct data) and [`discovery-pipeline.md`](discovery-pipeline.md)
(the automated candidate pipeline).

There is no national registry of data centers. The information exists, but it is
scattered across county planning portals, utility interconnection queues,
securities filings, and local reporting — and no single source is complete.
Compute Atlas assembles that public record into one dataset, with a citable
source behind every field.

## How facilities are discovered

Records reach the dataset through three channels. All three feed the same
human-gated staging queue — none writes a live facility directly.

### 1. Primary-source research

The core method is reading the primary public record — the permit, the filing,
the queue entry — rather than aggregating secondary coverage. In practice the
most productive channels are:

- **County and municipal planning & zoning portals.** Rezoning cases, special-use
  permits, site plans, and board-of-supervisors agendas are where a data-center
  campus first becomes a public fact — usually months before it appears in the
  press. These carry the load-bearing detail: acreage, building counts,
  substation capacity, conditions, and the vote. A county's own project database
  or numbered case pages are the anchor; third-party permit mirrors are used only
  to locate a case number, never as the citation.
- **Securities filings (SEC EDGAR).** For public operators — particularly the
  crypto-mining and neocloud companies converting sites to AI compute — the
  10-Q, 10-K, 20-F, and 8-K name sites, capacities, and dates with legal
  precision. The "subsequent events" footnote is the highest-value section: it
  catches acquisitions and new sites, with hard megawatt, acreage, and price
  figures, before any announcement. Filings often omit a town or county, so a
  finding is only recorded once the site can be responsibly geocoded.
- **ISO/RTO interconnection and large-load queues.** PJM, ERCOT, MISO, SPP,
  ISO-NE, and CAISO publish interconnection and large-load requests that are a
  primary signal for behind-the-meter power and grid-scale compute demand. These
  are recorded only when an entry (or a paired document) identifies a real,
  mappable site — an anonymous queue position is logged as a lead, not a record.
- **Utility, PUC, and economic-development records.** Large-load tariff filings,
  integrated resource plans, development-authority bond validations, and tax-
  incentive approvals corroborate — and sometimes first surface — a project's
  scale and status.

This research runs in periodic waves. Each wave works a set of jurisdictions or
filing channels in parallel, anchors every candidate to a primary record, checks
it against the live dataset for duplicates, verifies the consequential claims
independently, and stages the survivors for human review. Wave notes are kept in
the maintainer's working ledger; the resulting records are what appear in the
dataset.

### 2. The automated discovery pipeline

A local, scheduled pipeline proposes candidates and re-checks existing facilities
for status changes on a rotating per-state cadence. It is bounded, fail-closed,
and staging-only — it never writes a live facility. Full detail:
[`discovery-pipeline.md`](discovery-pipeline.md).

### 3. Community contributions

Anyone can suggest a facility or a correction. Every contribution is moderated
against its sources before it enters the dataset. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## The sourcing standard

**Every fact needs a public source URL that anyone can verify.** A record cannot
enter the dataset without one.

- **Primary sources first.** A primary record is the underlying document — a
  county case or staff report, a permit, an SEC filing, an interconnection-queue
  entry, a subsidy record. News and trackers are useful leads and corroboration,
  but the goal is to cite the primary record, not the article about it. Where a
  record's strongest available source is reporting rather than a filing, its
  `kind` says so and its confidence is set accordingly.
- **Corroboration for consequential claims.** Extraordinary figures — a
  multi-gigawatt campus, a multi-billion-dollar investment, a contested status —
  are checked against a second source before they are recorded.
- **Colocation marketplaces are leads, not citations.** Listing directories and
  colo marketplaces aggregate specifications without publishing where they came
  from, and they go stale silently — a facility sold to another operator years
  ago can still carry its former owner's name. They are useful for finding
  candidates and worthless for establishing facts. A figure that appears only in
  such a directory is omitted rather than recorded.
- **A citation names who published it.** The `publisher` on a source is the
  organization that actually put the page up. An aggregator's page about an
  operator is credited to the aggregator, never to the operator — otherwise a
  record looks corroborated by a company that never said the thing.
- **Capacity is omitted when it cannot be sourced.** Roughly half of the records
  carry no `capacityMw`, because most operators simply do not publish per-site
  megawatts. That gap is deliberate. An absent figure is a fact about the public
  record; an invented one would be a fact about nothing.
- **A source is not an endorsement.** Citing a source means the claim traces to
  the public record, not that the underlying fact has been independently audited.
  Readers can, and should, follow the source.

## Verification

Before a candidate is staged, its consequential and uncertain claims are
re-checked independently — the primary source is re-read to confirm it actually
says what the record claims, the site is confirmed to be a distinct real project
(not rumor or a landowner's unstated intent), and the location is confirmed to be
mappable. This step is adversarial by design: the default posture is to try to
refute a candidate, and it survives only if it holds up. It routinely catches
errors — a miscopied capacity figure, a status that a later vote overtook, a
name that turns out to be a duplicate — before they reach the dataset.

Locations follow a geocoding discipline. When a primary source gives a parcel or
street address, the coordinate is exact. When it names only a town, the record
carries the town centroid and is marked `approximate` in the `precision` field —
never presented as a parcel-level point it is not.

## Deduplication

A candidate is checked against the entire live dataset before it can be staged:

- by facility `id`,
- by a normalized `name` + `state` + `city` key,
- by a `state` + `city` overlap scan that surfaces same-site/different-slug
  duplicates a name match would miss,
- and, in dense clusters where one operator files several campuses in one town,
  by parcel- and case-number attribution rather than name matching.

Near-name collisions are a known trap — two genuinely distinct campuses can share
an operator and a near-identical name, while the same campus can appear under two
different slugs. These are resolved deliberately, not by string match alone.

## The human approval gate

Nothing becomes a live facility automatically. Every candidate — from the
research waves, the automated pipeline, or a public contributor — lands as a
`pending` submission and is promoted only by an explicit human approval. Public
intake is anonymous and moderated and can only ever stage a pending record;
privileged writes require an admin credential. This "open output, curated intake"
model is what keeps the dataset trustworthy: the data and code are fully open,
but volume never bypasses review.

## Map data pipeline

The optional map overlays and per-facility siting-context metrics are built from
public, static sources via `scripts/build-map-data.mjs` (invoked as
`npm run build:mapdata`). The script fetches several public datasets; the
overlays below are simplified to GeoJSON and committed as static assets in
`public/data/` (each lazily loaded only when its layer is toggled on):

- **Waterways** — Natural Earth generalized rivers/lakes geometry (public domain).
- **Transmission lines** — HIFLD "Electric Power Transmission Lines" (public
  domain, U.S. Government Works).
- **Drought** — U.S. Drought Monitor (NDMC / USDA / NOAA) point-in-time snapshot,
  with an "as of" date recorded in `public/data/map-layers.json`.
- **Baseline water stress** and **groundwater decline** — WRI Aqueduct 4.0,
  hydrological-basin polygons (licensed CC BY 4.0). Rendered with single-hue
  light→dark ramps so severity reads by luminance, not hue.
- **Principal aquifers** — USGS Principal Aquifers of the United States
  (public domain), mapped at 1:2,500,000 — regional context, not site
  hydrogeology.

The script also pre-computes `data/siting-context.json`, which holds each
facility's nearest named surface water (via USGS National Hydrography Dataset),
nearest ≥230 kV transmission line (via HIFLD), the water stress / groundwater
trend of its surrounding basin (WRI Aqueduct 4.0), and the underlying principal
aquifer (USGS) — the latter three by point-in-polygon lookup. This siting
context is shown on the facility page and in the map popup. Distances denote
**proximity only** — not stated water withdrawals or grid interconnections; the
basin and aquifer values are **regional context**, not the facility's measured
water use. All data is source-cited; no per-request geospatial API is used
(cost: $0).

## Zero fabrication

The dataset has a deliberate bias against inventing detail.

- **Omit the unknown.** A field with no source is left empty, not guessed.
  Coordinates, capacity, operator, investment, and dates are never fabricated.
- **Numbers only when firm.** Ranges, ceilings, and modeled projections live in a
  record's notes, not in a numeric field. A multi-year subsidy total is described
  in the program label rather than asserted as one dollar figure. Statutory
  *eligibility* for an incentive is not recorded as an award.
- **Honest confidence.** Records are marked `confirmed`, `reported`, or `rumored`,
  and uncertainty is surfaced rather than hidden. A candidate whose facts don't
  hold up is held, not padded into the dataset.

## How to read a record's sources

Every facility carries a `sources` array; the [live API](../README.md#api) and
the [JSON export](../data/facilities.json) expose it in full. Reading a record
means reading its provenance:

- **`sources[]`** — one entry per citation, each with a `url`, a human `label`, an
  optional `publisher`, a `retrievedAt` date, and a `kind`. The `kind` tells you
  what type of record it is:
  - `permit` — a government permit, rezoning, or planning case;
  - `filing` — an SEC or regulatory filing;
  - `iso_queue` — an ISO/RTO interconnection or large-load queue entry;
  - `subsidy` — a subsidy or incentive record;
  - `press` — reporting or a company announcement;
  - `osm` — OpenStreetMap or another open geographic source;
  - `other` — anything that doesn't fit the above.

  The `kind` mix is the fastest read on how a record is grounded: a `permit`- or
  `filing`-anchored record rests on a primary document; a `press`-only record
  rests on reporting and is usually held at `reported` confidence.
- **`confidence`** — `confirmed`, `reported`, or `rumored`, describing how firmly
  the record's core facts are established.
- **`statusHistory[]`** — an append-only audit trail of status changes, each dated
  and tied by `sourceIndex` to the source that corroborates it. It is never
  reordered or rewritten; new events and sources are appended, so the trail stays
  intact.
- **`location.precision`** — `exact` when the coordinate is a real footprint,
  `approximate` when it is a geocoded town/parcel centroid, or `representative_multi_site` when the facility spans multiple discrete sites (e.g. a campus or distributed fleet) and the coordinate is an illustrative point only.

Put together: follow the `sources`, weigh the `confidence`, and read the
`statusHistory` — that is what "source-cited" means here, and it is the whole
point of the project.

## Stakeholders

An optional `stakeholders[]` array names people with a documented stake in a
specific facility. Coverage is deliberately sparse — not because data is missing,
but because the field follows a strict site-level standard that excludes most
candidates.

**The site-level standard:** A source must name the person in connection with
THIS facility, not merely its operator. "Zuckerberg runs Meta and Meta owns this
site" does not qualify. The person must have a stake documented through a
verifiable public source tied directly to the facility. This is why a record with
20 executives named in operator-level filings may carry zero stakeholders.

**Why `sourceIndex` and `asOf` are required:** Both are mandatory, unlike the
optional `sourceIndex` on `jobs` and `community`. A name without a citation is
not acceptable in a public record, and stakes change — a person's title or role
at a facility may have shifted since a source was published, so `asOf` marks
when that stake was documented.

**Role categories:**

- **Financial interests:** `founder`, `controlling_owner`, `investor`, `executive`,
  `board_member`, `landowner`.
- **Governmental role:** `public_official` — a person with a documented approval,
  permit, or incentive role (e.g., a regulator issuing a permit, an official who
  approved a subsidy). This is NOT a financial interest; the facility page renders
  it as a separate group with a caption saying listing does not imply financial
  involvement.

The field is excluded from both the automated discovery pipeline and public
corrections. Stakeholders are added through maintainer research and human review
only — a local model must never be able to name a private individual.

## Emissions

An optional `emissions` object records **permitted annual emission limits taken
from a facility's air permit** (PSD, Title V, or a state construction permit).

**These are regulatory ceilings, not measured output.** A permit states the most
a facility is allowed to emit, which is not what it actually emitted. The facility
page says so wherever the figures appear, and the two must never be presented
interchangeably.

**Nothing here is derived.** Converting capacity to tonnage would require a
capacity factor and an emission rate — it would be an estimate wearing the
clothes of a citation, and it is not done. Every value is a number printed in a
permit, recorded in the permit's own units exactly as written. Units are never
converted, short-term limits are never annualised, and a permit stating metric
tonnes or a non-annual averaging period is recorded as written with the deviation
noted rather than normalised.

**`basis` is required whenever any tonnage is recorded**, because real permits
are not uniform:

- Some state **facility-wide** caps (PA DEP Plan Approval 32-00457A caps Homer
  City at 1,142.8 tons/yr NOx across the whole site).
- Others state **per-unit** caps (MDEQ PSD 0680-00119 caps each turbine at
  5.60–15.47 tons/yr NOx depending on model, across 41 turbines).

An unqualified number is ambiguous between those two readings, and reporting a
per-turbine limit as a site total would be a serious error. `averagingPeriod`
records whether a limit is a calendar year or a rolling 12-month total — permits
commonly use the latter.

**`unitsCovered` records what equipment the permit actually authorises**, in the
permit's own words. A permit does not always cover the same equipment a record
describes: a site may operate units beyond those a given permit authorises, and
attaching that permit's limits to the whole site would cite real numbers against
the wrong hardware.

**A missing `co2e` does not mean "no greenhouse-gas limit."** Some permits
constrain GHGs only as an efficiency *rate* (e.g. lb/MMBtu) with no annual
tonnage at all. The field is left unset and the reason recorded in `notes`.

Like `stakeholders`, this field is excluded from the automated discovery pipeline
and from public corrections. It is added through maintainer research against the
permit document itself.

## Cooling type

An optional `water.coolingType` field classifies a data center's heat-rejection
method by water consumption — the axis rendered on the `/power` page as
"Evaporative (high water)," "Hybrid," "Closed-loop (low water)," and
"Air-cooled (minimal)." This rule was not written down before now; the four
values existed but curators had no documented standard to apply them against.

- **`evaporative`** — heat is rejected by evaporating water, as in a cooling
  tower or adiabatic/evaporative assist. Water is consumed continuously.
- **`hybrid`** — the design switches between evaporative and dry modes, for
  example wet cooling in summer and dry cooling in winter. Water is consumed
  seasonally. It does **not** mean a mix of air and liquid cooling inside the
  building: that describes how heat is captured at the rack, not how it leaves
  the site, and every value here classifies heat rejection.
- **`closed_loop`** — a recirculating water or coolant circuit that is not
  evaporated. Water is consumed only as occasional makeup.
- **`air`** — no cooling water circuit at all: dry or direct air cooling,
  described by the operator as "waterless" or "zero water for cooling." Water
  use is limited to ordinary plumbing.
- **`unknown`** — a source addresses cooling but does not identify the method.

**The tie-breaker:** a facility with a water circuit that recirculates is
recorded as `closed_loop`, even when heat is ultimately rejected to air via
air-cooled chillers or dry coolers. `air` is reserved for designs with no
cooling water circuit at all. Operators frequently market a closed-loop design
as "air-cooled," so the marketing phrase alone does not decide the value — the
presence of a recirculating water circuit does.

## See also

- [`README.md`](../README.md) — what the dataset is and the public API.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to add a facility or a correction.
- [`discovery-pipeline.md`](discovery-pipeline.md) — the automated candidate pipeline.
- [`lib/schema.ts`](../lib/schema.ts) — the authoritative Zod data model.
