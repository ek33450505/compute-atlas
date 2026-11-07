# Test fixtures

A ~68-record sample of the public dataset. Vitest aliases `@/data/*.json` to these files (see `vitest.config.ts`), so the default `npm test` never depends on the full dataset. `DATASET=real` (`npm run test:dataset`) drops the alias and runs only the `*.dataset.test.ts` invariants against the real `data/` snapshot.

| Fixture | Mirrors |
| --- | --- |
| `facilities.fixture.json` | `data/facilities.json` |
| `facilities.meta.fixture.json` | `data/facilities.meta.json` (`recordCount` = fixture length) |
| `siting-context.fixture.json` | `data/siting-context.json` (fixture ids only) |
| `operator-ownership.fixture.json` | `data/operator-ownership.json` (fixture operators only) |

`scripts/ensure-data-snapshot.ts` also copies these into `data/` when no snapshot exists and no Neon export is available (outside Vercel; CI sets `ALLOW_FIXTURE_SNAPSHOT=1`).

## Source

Commit `86fef0c`. **Every record must stay deep-equal to its `86fef0c` version.** Run `npm run fixtures:verify` (`scripts/verify-fixture-public.sh`); it exits 1 and names any record that differs or has no counterpart at that commit. Never edit a record by hand to suit a test: pick a different record, or fix the test.

## Selection rules

- Records keep the original relative order; files are `JSON.stringify(x, null, 2) + "\n"`.
- Every id/slug hard-coded in an existing test (`*.test.ts(x)`, `e2e/*.spec.ts`, `tests/**/*.bats`) is included.
- Every `facilityType` and every `status` value present in the data.
- One state with several records (TX, OH).
- Operators that have rows in `operator-ownership.json`.
- Records with `stakeholders`, and records with `notRecorded`.
- Records whose siting-context entry has no `nearestWater`. Three Alaska records (`greensparc-*-ak`) have an entry with no `nearestWater` (NHD is CONUS-only, so they are not NHD debt). Every fixture id still has a siting-context entry; `lib/siting-context.test.ts` asserts that.

## Adding a record

1. Take the record from `git show 86fef0c:data/facilities.json` (or a later commit, then update the source commit above and `SRC_COMMIT` in the script).
2. Insert it at its original relative position, add its siting-context entry and its operator's ownership row if any, and bump `recordCount` in the meta fixture.
3. `npm run fixtures:verify && npx vitest run tests/fixtures`.
