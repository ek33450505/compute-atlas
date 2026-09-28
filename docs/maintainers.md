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
npm run db:sync -- --apply --skip-notify   # 2b. publish without emailing facility subscribers
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

**`--skip-notify` flag for metadata-only publishes.** Use it when a wave touches
many records without changing any asserted fact — the canonical example is a
source-URL dedupe where only redundant citations disappear. The flag suppresses
notification to **facility subscribers only** (`targetType='facility'`). State
subscribers receive only the monthly digest, never transactional updates, so
`--skip-notify` has zero effect on them. The flag is deliberately opt-in and
never inferred: decide whether the change matters to a human reader, and pass
it explicitly. A heuristic that guesses wrong fails silently in the wrong
direction — not telling someone about a fact they asked to know about.

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
| `CRON_SECRET` | Bearer secret for `/api/cron/*`. **Leave unset** — see below. Must differ from `API_ADMIN_TOKEN` |
| `STATE_DIGEST_ENABLED` | Kill switch for the monthly state digest. **Set to `"true"` in production since 2026-09-14.** Unsetting it (or any value but `"true"`) stops all digest mail immediately, without a deploy |
| `SUBMISSION_NOTIFY_ENABLED` | Kill switch for "email me when my submission is reviewed". **Set to `"true"` in production since 2026-09-14.** Same kill semantics |
| `CRON_SECRET` | Authenticates Vercel Cron to `/api/cron/state-digest`. **MUST NOT equal `API_ADMIN_TOKEN`** — see that route's header for why an equal value silently disables the admin recovery path |

✅ **The monthly state digest is LIVE as of 2026-09-14** (Ed's decision). Both switches that
held it off are flipped: `vercel.json` carries
`"crons": [{ "path": "/api/cron/state-digest", "schedule": "0 9 1 * *" }]` — 09:00 UTC on the
1st — and `STATE_DIGEST_ENABLED=true` plus `CRON_SECRET` are set in the Vercel project env.

**Audience at flip time: two confirmed `state` subscribers, OR and VA, one each.** The three
pending rows (MO, SD, TX) are never read — the query is `status='confirmed'` only. The first
scheduled run (2026-10-01) covers September 2026, a month in which OR saw 21 history rows
across 20 facilities and VA 31 across 30, so the first digest is a substantial one.

⚠️ **Widening that audience is a NEW decision, not this one.** A backfill of pending rows, a
new `targetType`, or a catch-up over months that were never sent all resume mail to people
who have not been counted here. Ed decided about these rows and this schedule.

The idempotency prerequisite is now closed (D3). Every call claims its `(since, until)`
window in `state_digest_runs` before building or sending anything, so a repeat call for the
same window is a no-op rather than a duplicate send. Read the enable checklist in the route
file's header before flipping either switch — it explains `completedAt IS NULL` (a prior run
that claimed a window and crashed before finishing) and why a deliberate resend requires
deleting that window's row rather than a `?force=` parameter.

✅ **"Email me when reviewed" is LIVE as of 2026-09-14** (Ed's decision).
`SUBMISSION_NOTIFY_ENABLED=true` is set in production.

**Enabling mailed nobody retroactively, verified before the flip:**
`submission_notify_requests` held **0 rows**, because with the flag off no submission could
record an address. The 37 submissions pending at the time therefore carry no `notifyEmail`,
and approving any of them sends nothing. The feature is purely forward-looking — the first
mail goes to the first person who opts in on a NEW submission and is then reviewed.

The historical note on the disabled state follows, because it still describes what unsetting
the flag returns you to: with `SUBMISSION_NOTIFY_ENABLED` unset, `POST /api/contribute`
ignores a `notifyEmail` entirely — not read, not validated, not stored, responses
byte-identical to before the feature existed.

Two things were true before it was set to `"true"`, and stay true for any future re-enable:

1. **The migrations must be applied.** `drizzle/0011_*` and `drizzle/0012_*` create
   `submission_notify_requests` and `submission_notify_sends`. Nothing in CI runs
   `db:migrate`, and `scripts/check-schema-drift.ts` derives its expected-table list from the
   `pgTable` exports — so `drift-alert.yml` (22:00 UTC daily) goes red until Neon has both.
   That red is correct, not a false alarm.
2. **Understand what the two caps do, because they are not the same control.**
   `checkSubmissionNotifyCap` bounds how many notify requests may be *outstanding* per address
   (5/hour). It does NOT bound mail volume: the request row is deleted at review time, so
   every review pass clears the count. `checkSubmissionNotifySendCap` is the one that bounds
   volume — a persistent, salted-hash counter (`submission_notify_sends`, 5 per address per 30
   days) written *before* each send, so a failed send still spends budget. Without it, a single
   actor inside the existing per-IP budget could aim unbounded mail at one address, using the
   maintainer's own review pass as the delivery mechanism.

Note the address is stored in plaintext while a request is outstanding — it has to be, to mail
it — and is deleted the moment its one email is sent, on review even if that send failed, and
by `scripts/retention-prune.ts` after 90 days for submissions nobody ever reviewed.

⚠️ **`.env.local` quoting.** `vercel env add` keeps surrounding quotes, and a quoted
`DATABASE_URL` is invalid and fails *silently* — there is no fallback. Strip the quotes.

## Secret rotation

Nothing in this project had ever been rotated as of the 2026-09-27 security audit — every Vercel
variable still had `createdAt == updatedAt`, oldest 76 days. This is the runbook; work **top to
bottom**, because the order matters in two places.

⚠️ **A new or changed Vercel env var is invisible to already-built deployments.** Vercel injects env
at deploy time, so every rotation below needs
`npx vercel redeploy --target production <url>` before it takes effect. A rotation that "didn't work"
is usually a missing redeploy.

**0. `NEON_API_KEY` — revoke, do not rotate.** Nothing consumes it (zero references across
`.github/`). It is a **control-plane** key: it can create/delete branches, reset role passwords and
read connection strings, so it can mint a fresh `DATABASE_URL` *after* you rotate the database
password. The GitHub secret was deleted 2026-09-27; **revoking the key itself in the Neon console is
a separate step** and deleting the secret does not do it. Do this before step 1. Breaks: nothing.

**1. `DATABASE_URL` (+ `DATABASE_URL_UNPOOLED`).** The app connects as `neondb_owner`, which is a
member of `neon_superuser` with `rolcreaterole`/`rolcreatedb`/`rolbypassrls`/`rolreplication` and owns
all 14 public tables — verified by SQL, and far more than the DML the app needs. Reducing that was
considered and **deliberately deferred**: the least-privilege split's own failure mode (a missing
`GRANT` on a new table after `db:migrate`, silently breaking production writes) is higher-probability
than the attack it prevents, for a single-maintainer project. Revisit if a second person gains DB
access or real personal data lands in the schema.
To rotate the credential without the privilege split: reset `neondb_owner`'s password in Neon →
update Vercel production → **redeploy** → update `.env.local` → update the GitHub `DATABASE_URL`
secret → `npm run check:drift` to confirm the workflows still connect.
Breaks if you do it out of order: `db:sync`, `db:export`, `check:drift`, `drift-alert.yml`,
`discovery-watchdog.yml`, `neon-sync.yml` and CI's DB test, all at once.
⚠️ `DATABASE_URL_UNPOOLED` exists in all three Vercel environments and **no code reads it** (the Neon
integration creates it). It is a second copy of the same credential — rotate it in lockstep or remove it.

**2. `API_ADMIN_TOKEN`.** Grants every admin write route, the admin UI, discovery staging writes and
the cron recovery path. ⚠️ **Rotating it invalidates every live `admin_session` cookie**, because the
cookie HMAC is keyed by the raw token (`lib/admin-session.ts`, `signV2Parts`). There is **no overlap
window** — the code compares against exactly one value, so it is a hard cutover.
Order: Vercel production → **redeploy** → `.env.local` (the `submissions` CLI, `sync-to-neon.ts` and
`submit-candidates.ts` all read it) → log in to `/admin` again.
Do it when **no nightly `run.sh` discovery run is in flight**.

**3. `NEON_SYNC_PAT`.** Needs `Workflows: RW` and `neon-sync.yml` runs `gh pr merge --squash --auto`,
so a leaked value can rewrite CI *and* auto-merge to `main` → production. Mint a new **fine-grained**
PAT (this repo only, Contents/PRs/Workflows RW, with an expiry) → update the secret →
`gh workflow run neon-sync.yml` → watch the "Preflight — verify the PR token can still write" step.
⚠️ That preflight proves `Contents: write` only and **cannot** prove `Workflows` — a token missing that
scope passes preflight and fails at the real push. Revoke the old PAT after one green run.

**4. `RESEND_API_KEY`.** Can send as `alerts@compute-atlas.com` (reputational, not data — the key is
verified send-only: Resend answers `401 restricted_api_key` to key/domain/email reads). New
sending-only key → Vercel production → **redeploy** → `.env.local` → delete the old key.
⚠️ A botched rotation is **invisible**: `lib/email.ts` returns `null` on an unset/bad key and sends
become a logged no-op. Verify with a real confirm send, not by absence of errors.

**5. `CRON_SECRET`.** Low blast radius (the monthly digest trigger). Rotate freely — but it **must
stay different from `API_ADMIN_TOKEN`**, or `hasValidCronSecret` short-circuits and the
`?since=&until=` manual-recovery path becomes permanently unreachable with your own token.

**6. `API_ADMIN_TOKEN_SALT`.** The PBKDF2 salt for the admin-UI password. Rotating it invalidates the
stored derivation — treat it as "change the admin password", never as a standalone rotation.

**7. ⛔ `CONTRIBUTE_IP_SALT` — do NOT rotate casually.** Every `submitter_ip_hash` in production was
computed with this salt. Changing it silently orphans every stored row: rate-limit history resets, and
the notify-email hashes and send-cap counter stop matching. Deliberate migration only.
⚠️ Since 2026-09-27 it has a **second consumer**: `lib/subscribe-consent.ts` derives the
subscribe-consent cookie's HMAC key from it (under its own `KEY_DOMAIN`, so the uses cannot collide).
Rotating therefore also invalidates every outstanding consent cookie — harmless on its own (30-minute
lifetime; those users simply get the ordinary double-opt-in email), but it means this value is no
longer only about IP hashes.

**8. `INDEXNOW_KEY`.** Public by design. If changed, write the new `public/<key>.txt` and delete the
old one in the same commit — `indexnow.test.ts` asserts the file matches the constant.

**9. `EDGE_SHARED_SECRET` — ⚠️ THERE IS NO SAFE TWO-STEP ORDER once the gate is fail-closed.**
An earlier version of this section said rotation was "safe in either order because the check is
fail-open when unset." That is only true *before* the gate is armed — i.e. before there is anything to
rotate — and it would have prescribed exactly the outage it warned about. Corrected 2026-09-27 after
review caught it.

`isEdgeOriginAllowed` compares the presented header against **one** value. So once armed:
- Change the Cloudflare rule first ⇒ presented(new) ≠ expected(old) ⇒ **403**.
- Change Vercel first ⇒ presented(old) ≠ expected(new) ⇒ **403**.

Either way every `/admin` and `/api` request 403s until the second half lands (site-wide once the
matcher is widened in activation step 5). Use one of these instead:

**Option A — three phases, no code change (recommended).** Disarm, swap, re-arm:
1. **Unset** `EDGE_SHARED_SECRET` in Vercel → `npx vercel redeploy --target production <url>`. The
   gate is now fail-open; traffic is unaffected and unprotected.
2. Change the Cloudflare Transform Rule to the new value. Verify with a real GET.
3. **Set** the new `EDGE_SHARED_SECRET` → redeploy. Verify a browser request works **and** that
   `curl --resolve 'www.compute-atlas.com:443:76.76.21.21' https://www.compute-atlas.com/api/stats`
   is refused.
⚠️ Steps 1–2 are a genuine window with no origin protection. Keep it short; it is not a secret leak,
only a period where the bypass is open again.

**Option B — accept an overlap, needs a code change.** Have `EDGE_SHARED_SECRET` parse a
comma-separated list and accept any member (still `timingSafeEqual` per candidate, constant work per
request). Then: add the new value alongside the old → redeploy → change the Cloudflare rule → remove
the old value → redeploy. No unprotected window. Do this if rotation is ever expected to be routine.

Either way: **verify with a real GET, not by absence of errors** — a 403 from this gate looks identical
to any other 403, and Cloudflare could cache it (`proxy.ts` sets `no-store` on that response for
exactly this reason).

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
