# Maintainer operations

Everything in this file requires `DATABASE_URL` and is only useful if you hold it.
Contributors don't need any of it — see [CONTRIBUTING.md](../CONTRIBUTING.md) instead.

## The one rule: the database is the source of truth

`data/facilities.json` is a **generated artifact**. It is never hand-edited to publish a
change. The site reads Neon live, so a data correction does not need — and should not
wait for — a deploy.

Editing the JSON and shipping it through git makes every correction a Vercel deploy and
leaves drift to be detected and repaired afterwards. Publishing to the database first
makes that drift structurally impossible, which is what turns `check:drift` into a real
invariant rather than a report.

## A data wave, in order

```bash
npm run db:sync              # 1. DRY RUN by default — prints the plan, writes nothing
npm run db:sync -- --apply   # 2. publish adds + updates, write history, bust cache tags
npm run db:export            # 3. regenerate data/facilities.json from the live DB
npm run build:mapdata        # 4. rebuild map overlays + per-facility siting context
                             # 5. commit the regenerated files
```

**Step 4 is part of the wave, not an optional extra.** A new facility has no entry in
`data/siting-context.json` until it runs, so its page silently renders without the
"Siting context" panel — no error, just a missing section. Use the full run, not
`--skip-nhd`: that flag reuses existing `nearestWater` / `nearestTransmission` values,
which is exactly what new records lack.

**Diff-read the result.** It should be additive — fills and new entries. Any
`value → null` is data loss, not a refresh. A clean exit code is not evidence the work
was done; the diff-read is the only thing that catches a partial rebuild.

## What each write path actually does

| Path | Adds | Updates | Writes history | Busts cache tags |
|---|:--:|:--:|:--:|:--:|
| `db:sync -- --apply` | ✅ | ✅ | ✅ | ✅ |
| `db:seed` | ✅ | — | — | — |
| `db:seed -- --force` | ✅ | ❌ **silently drops** | ❌ | ❌ |

`db:sync` refuses to overwrite a Neon row that has moved ahead of the JSON's basis (the
`asOf` in `data/facilities.meta.json`), so it cannot clobber a production approval.

`db:seed` is **bootstrap-only**, for filling an empty database. Its `--force` variant
silently drops every correction to an existing row, writes no history, and busts no
tags — it is not a publish path.

A raw Neon write (`db:seed --force`, an ad-hoc upsert) leaves cache tags un-busted. Bust
them yourself with the admin-bearer `POST /api/revalidate`, e.g.
`{"tags":["facilities","state:CA"]}`. Brand-new facility ids need no bust — a cache miss
populates them.

`db:sync` cannot reach the search index behind the global ⌘K palette; that is an
untagged 24-hour timer and refreshes on its own schedule.

## Scripts

| Command | What it does |
|---|---|
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:sync` | Diff JSON against Neon and print the plan; `-- --apply` publishes |
| `npm run db:export` | Write the live database back to `data/facilities.json` |
| `npm run build:mapdata` | Rebuild static map overlays and siting context |
| `npm run check:drift` | Read-only JSON ↔ Neon drift report |
| `npm run db:seed` | Bootstrap-only: populate an empty database |
| `npm run submissions -- list pending` | Review the staging queue |
| `npm run submissions -- approve <id> "note"` | Promote a pending submission to live |
| `npm run submissions -- reject <id> "note"` | Reject a pending submission |
| `npm run check-sources` | Source-liveness report (read-only) |

## Environment

See `.env.example`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres pooled connection string |
| `API_ADMIN_TOKEN` | Bearer token for admin write endpoints |

⚠️ **`.env.local` quoting.** `vercel env add` keeps surrounding quotes, and a quoted
`DATABASE_URL` is invalid and fails *silently* — there is no fallback. Strip the quotes.

## Releases

The project follows [Semantic Versioning](https://semver.org). Releases are published via
[GitHub Releases](https://github.com/ek33450505/compute-atlas/releases) and automated with
release-please; see [CHANGELOG.md](../CHANGELOG.md).

Each release exports a versioned snapshot — `data/facilities.json` carries an `asOf`
timestamp in `data/facilities.meta.json` so consumers can track data currency.

## Builds are gated, production included

`vercel.json` runs `scripts/vercel-ignore-build.sh` as Vercel's Ignored Build Step. Any
deployment whose diff touches only `data/`, `docs/`, `.github/` or `*.md` is skipped —
production too, because `db:sync` puts data live in Neon before the commit recording it
is ever merged.

The one thing a production build still refreshes on a data-only merge is the
`withJsonFallback` snapshot bundled from `data/facilities.json`. That rides the next code
deploy, or `npx vercel redeploy --target production` on demand.

If you touch that script, verify it by reading the real build log
(`npx vercel inspect --logs <url> | grep vercel-ignore`), never by local probes alone. It
**fails open** — any uncertainty builds — which means a broken gate looks identical to a
working one.

## Discovery pipeline

A local, scheduled pipeline (`scripts/discovery/`) that proposes new facilities and
re-checks existing ones. It never writes live facilities; everything it produces stages as
`pending`. It runs under `launchd` on the maintainer's machine and uses a local Ollama
model for source verification — treat it as an operator tool, not part of the deployed app.

- Architecture and the safety contract: [discovery-pipeline.md](discovery-pipeline.md)
- Operator mechanics (launchd, `ollama pull`, running it by hand):
  [discovery-runbook.md](discovery-runbook.md)

## Caching, briefly

Three independent tiers, all reading from Neon:

- **Aggregate pages** (home, map, table, stats, explore) — 1-hour timer, tagged
  `facilities`. Self-heal within the hour even if a tag bust is missed.
- **Facility pages** — scoped tags only (`facility:<id>`, `operator:<slug>`, `state:<XX>`,
  plus `power-generation` where relevant), floored at 24 hours. A bust is how they refresh.
- **Search index** — 24-hour untagged timer. No tag bust reaches it.

The tag vocabulary lives in `lib/cache-tags.ts` and is shared by `lib/facility-write.ts`
and `POST /api/revalidate`, so producer and validator cannot drift apart.

⚠️ Locally, a restart does **not** clear `.next/cache`, so a "fresh" dev server can replay
an ISR-cached page from before the last publish. That looks exactly like JSON ↔ Neon drift
but isn't — `check:drift` compares *data* and cannot see a stale *render*. Run
`rm -rf .next/cache` and re-fetch before concluding anything.
