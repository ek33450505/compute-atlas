# Compute Atlas data

`data/` is a local, gitignored snapshot of the live database. Nothing under it is committed;
Neon is the only home of the records.

- `npm run db:export` writes `facilities.json`, `facilities.meta.json`, `siting-context.json`
  and `operator-ownership.json` there from Neon. `facilities.meta.json` records when the snapshot
  was generated (`asOf`) and how many records it holds.
- `scripts/ensure-data-snapshot.ts` (run by `prebuild`/`predev`) exports from Neon on Vercel
  and fails closed if that export fails in production. Elsewhere it copies the fixtures from
  `tests/fixtures/` into missing files (`facilities.json` and its meta are copied as a pair, so
  a missing `facilities.json` replaces an existing meta too), and in CI or with
  `NODE_ENV=production` it refuses a missing file unless `ALLOW_FIXTURE_SNAPSHOT=1`.
- `npm run build:mapdata` writes its candidate output to `data/siting-context.next.json`;
  `npm run nhd:debt` keeps its ledger in `data/nhd-backfill-debt.json`.
- Search Console index-census artifacts live in `ops/index-census/`, not here.

For current records, see the live site at [www.compute-atlas.com](https://www.compute-atlas.com).

## License and attribution

The data is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
([`LICENSE-DATA`](../LICENSE-DATA)). If you reuse it, credit it like this:

> Data from Compute Atlas by Edward Kubiak (https://www.compute-atlas.com), licensed under
> CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

- **Link www.compute-atlas.com**, the dataset's home, rather than this repository.
- **Say what you changed.** For example: "filtered to data centers", "joined to counties", or
  "combined with our own research".
- **Keep your analysis distinct from the records.** Compute Atlas is non-partisan. It takes no
  position for or against any facility or operator, and it is not affiliated with any company,
  advocacy group, or government agency. Present your conclusions as yours.

For academic work, cite the facility page you used and the date you accessed it.

## Reading the records

An empty field means "not established from a public source". It never means zero. The dataset
is curated, not a census, so a facility's absence is not evidence that it doesn't exist. Every
record cites its own sources and carries a confidence level. See the
[methodology](https://www.compute-atlas.com/methodology).
