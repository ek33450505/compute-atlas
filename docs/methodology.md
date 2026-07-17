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
  `approximate` when it is a geocoded town/parcel centroid.

Put together: follow the `sources`, weigh the `confidence`, and read the
`statusHistory` — that is what "source-cited" means here, and it is the whole
point of the project.

## See also

- [`README.md`](../README.md) — what the dataset is and the public API.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to add a facility or a correction.
- [`discovery-pipeline.md`](discovery-pipeline.md) — the automated candidate pipeline.
- [`lib/schema.ts`](../lib/schema.ts) — the authoritative Zod data model.
