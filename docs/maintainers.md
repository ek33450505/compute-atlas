# Maintainer operations

Everything in this file requires `DATABASE_URL` and is only useful if you hold it.
Contributors don't need any of it — see [CONTRIBUTING.md](../CONTRIBUTING.md) instead.

## The one rule: the database is the source of truth

The data files under `data/` (`facilities.json`, `facilities.meta.json`, `siting-context.json`,
`operator-ownership.json`, `nhd-backfill-debt.json`) and the hero outputs
(`components/home/hero-plate-paths.ts`, `public/data/hero-points.json`,
`public/data/pipeline-history.json`) are gitignored local files, never committed and never
hand-edited to publish a change. The site reads Neon live, so a data correction does not need a
deploy. Old commits still serve the frozen open edition (3,025 records).

## A data wave, in order

```bash
npm run db:export            # 1. write the local data files from Neon
                             # 2. research and edit the local snapshot
npm run test:dataset         # 3. real-snapshot invariants; its `pretest:dataset` hook runs `npm run prebuild`
npm run db:sync              # 4. DRY RUN by default — prints the plan, writes nothing
npm run db:sync -- --apply   # 5. publish adds + updates, write history, bust cache tags
npm run db:sync -- --apply --skip-notify   # 5b. publish without emailing facility subscribers
```

There is no data commit. `db:sync` refuses a snapshot below the export floor (2,900 records)
or whose `facilities.meta.json` `recordCount` disagrees, in dry run and `--apply`, before any
database access ("looks like the test fixture; run `npm run db:export` first").

A fresh clone has no data files: run `npm run prebuild` (fixture mode outside Vercel; CI sets
`ALLOW_FIXTURE_SNAPSHOT=1` on its Seed step and the Playwright `webServer` only) before typecheck
and tests. Vercel builds export the snapshot from Neon and fail closed in production.
`docs/media/map.svg` is a frozen committed asset; `build:heroplate` no longer writes it.

### Local siting refresh

A new facility has no siting context until this runs, so its page renders without the "Siting
context" panel, with no error.

```bash
npm run db:export
npm run siting:refresh       # DRY RUN: build:mapdata -> additive guard vs Neon -> siting:apply dry run
npm run siting:apply -- --apply
```

`siting:refresh` cannot pass `--skip-nhd` or `--backfill-nhd`; run those `build:mapdata` steps by
hand. The additive guard refuses an empty Neon baseline ("run `npm run backfill:siting -- --apply` first"), and a
confirmed-NHD-absence clear fails it, so that clear needs a deliberate maintainer apply (an
allowlist is a follow-up). Use the full run, not `--skip-nhd`: that flag reuses existing
`nearestWater` / `nearestTransmission` values, which is exactly what new records lack. If a degraded
USGS NHD forces `--skip-nhd`, record it with `npm run nhd:debt -- --note "<why>"` (`-- --ledger-db`
mirrors it to Neon `maintenance_ledger`) and pay it later with `build:mapdata -- --backfill-nhd`.
`data/nhd-backfill-debt.json` is a local file that `db:export` does not recreate; the dataset ratchet
fails (does not skip) when it is missing.

**Diff-read the result.** It should be additive — fills and new entries. Any
`value → null` is data loss, not a refresh. A clean exit code is not evidence the work
was done.

### Ownership

Edit the local `data/operator-ownership.json` (from `db:export`), then `npm run ownership:apply`
(dry run) and `npm run ownership:apply -- --apply`. It inserts and updates, reads back and checks
the count, and always refuses removals: a removal is a reviewed manual Neon edit plus a revalidate.
It busts `operator:<slug>` and `facilities`, and needs `API_BASE_URL` and `API_ADMIN_TOKEN` unless
`--skip-revalidate`.

### Refresh site

The admin "Refresh site" button busts the `facilities` tag only. It does not regenerate the hero
plate, hero points or as-of date; the next build does. By decision (Ed, 2026-11-06), the button does not call a deploy hook.

### Pulling this change into a tree that has the data files

The pull deletes them. Back them up first (the NHD ledger has no other copy: the Neon row from `npm run nhd:debt -- --ledger-db` is a durable record of the count, but no command restores the local file from it; keep the backup, or re-record the current count with `npm run nhd:debt -- --note "<why>"`, which resets the ceiling to today's count), then run
`npm run db:export` (discovery's loader reads Neon first and aborts loudly on a bad snapshot).
Merge or pull only outside weekdays 13:00 (Mon-Fri).

## What each write path actually does

| Path | Adds | Updates | Writes history | Busts cache tags |
|---|:--:|:--:|:--:|:--:|
| `db:sync -- --apply` | ✅ | ✅ | ✅ | ✅ |
| `db:seed` | ✅ | — | — | — |
| `db:seed -- --force` | ✅ | ❌ **silently drops** | ❌ | ❌ |

`db:sync` refuses to overwrite a Neon row that has moved ahead of the snapshot's basis (the
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

A public correction can target a field a record marks `notRecorded` (the contributor may have a source). Approving it returns a 400, because a field cannot be both set and marked; remove the mark in the local `data/facilities.json`, run `db:sync`, then approve.

## Scripts

| Command | What it does |
|---|---|
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:sync` | Diff the local snapshot against Neon and print the plan; `-- --apply` publishes |
| `npm run db:export` | Write the live database to the local gitignored data files |
| `npm run build:mapdata` | Rebuild static map overlays and siting context |
| `npm run siting:refresh` | Dry run: `build:mapdata`, additive guard vs Neon, `siting:apply` dry run; `npm run siting:apply -- --apply` writes |
| `npm run ownership:apply` | Dry run of `data/operator-ownership.json` against Neon; `-- --apply` writes (removals refused) |
| `npm run test:dataset` | Vitest against the real snapshot (runs `prebuild` first) |
| `npm run check:schema` | Fail-closed schema-drift guard: exits 1 if the live database is missing a table the code expects, or if `DATABASE_URL` is unset or unreachable |
| `npm run ops:ci-monitor-role` | Dry run of the `ci_monitor` least-privilege role plan; `-- --apply --out <path> [--rotate]` creates/rotates it and writes its URL to `<path>` (see "CI database role") |
| `npm run db:seed` | Bootstrap-only: populate an empty database |
| `npm run submissions -- list pending` | Review the staging queue |
| `npm run submissions -- approve <id> "note"` | Promote a pending submission to live. Refuses (exit 2) when the facility it writes has confirmed watchers, because approving emails them; `list pending` marks those rows |
| `npm run submissions -- approve <id> "note" --notify-watchers` | Approve a watched submission and send its watchers the update. The API refuses the same approval with a 409 unless the body carries `notifyWatchers: true` |
| `npm run submissions -- reject <id> "note"` | Reject a pending submission |
| `npm run check-sources` | Source-liveness report (read-only) |

## Environment

See `.env.example`.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string: the pooled one (`-pooler` host) on Vercel production; the direct one in `.env.local`; the GitHub Actions secret holds the least-privilege `ci_monitor` URL (see "CI database role"). The app's `neon-http` driver accepts either; `drizzle.config.ts` (`db:migrate`) reads the same variable |
| `API_ADMIN_TOKEN` | Bearer token for admin write endpoints |
| `API_INTAKE_TOKEN` | Staging-only bearer; `POST /api/submissions` accepts it alongside `API_ADMIN_TOKEN`. Required by the scheduled discovery run (`DISCOVERY_REQUIRE_INTAKE_TOKEN=1`); a manual run with it unset falls back to `API_ADMIN_TOKEN`. Set in Vercel production and the pipeline's `.env.local` (see the `API_INTAKE_TOKEN` section below). **If set, it must be an independent value** |
| `CRON_SECRET` | Bearer secret authenticating Vercel Cron to `/api/cron/*`. **Set in production since 2026-09-14**, with the state digest; unset means every cron-path caller is rejected (fail-closed). **MUST NOT equal `API_ADMIN_TOKEN`** — see that route's header for why an equal value silently disables the admin recovery path |
| `STATE_DIGEST_ENABLED` | Kill switch for the monthly state digest. **Set to `"true"` in production since 2026-09-14.** Unsetting it (or any value but `"true"`) stops all digest mail, but only once a new deployment is live: Vercel applies env changes to new deployments only, so follow with `npx vercel redeploy --target production <url>` |
| `SUBMISSION_NOTIFY_ENABLED` | Kill switch for "email me when my submission is reviewed". **Set to `"true"` in production since 2026-09-14.** Same kill semantics (redeploy required), plus a Cloudflare purge for the form field: see "Turning it off" below |
| `WATCH_AREAS_ENABLED` | Kill switch for county and metro watching (`lib/watch-target-types.ts`). **ON unless the value is exactly `"false"`.** Off: `POST /api/subscribe` rejects county and metro targets with the same 400 as an unknown target type, and the monthly digest reads only state rows. Redeploy after a change (Vercel applies env changes to new deployments only). See "Turning county and metro watching off" below |
| `VERIFY_SOURCES_ENABLED` | Kill switch for the discovery pipeline's mechanical source-verification gate (local Ollama). **Polarity is the opposite of the two switches above:** the gate is ON by default and only the exact string `"false"` disables it, so a typo leaves verification enabled |
| `API_ADMIN_TOKEN_SALT` | PBKDF2 salt for the admin-UI password login (`app/admin/login/actions.ts`). Required — login fails closed, rejecting every attempt, if unset |
| `CONTRIBUTE_IP_SALT` | Salt for hashing submitter IPs for public-contribution rate limiting. **Required in production** — `hashIp()` throws on Vercel production rather than hash with the repo-public default; dev, tests and previews fall back to it. Since 2026-09-27 it has a second consumer: `lib/subscribe-consent.ts` derives the subscribe-consent cookie's HMAC key from it, under its own key domain. Rotating it invalidates every stored IP hash **and** every outstanding consent cookie. Since the email-send ledger it also salts every `email_sends` address hash (`hashAddress` calls `hashNotifyEmail`, the same function as the notify-email hashes), so rotation makes past ledger rows unfindable by address. The CLI and `/admin/email-sends` print only an 8-character hash prefix, never the address |
| `EDGE_SHARED_SECRET` | Shared secret proving a request actually traversed Cloudflare: a Transform Rule injects it as `x-edge-shared-secret` and `proxy.ts` compares digests. **Fails closed on production since 2026-10-15**: unset or empty 403s every matched path (`/admin`, `/api` except `/api/cron/*`, `/map`, `/data`, `/table`, `/facilities/*`, `/embed/*`). Checked only when `VERCEL_ENV === "production"`; `/api/cron/*` is exempt unconditionally. There is no safe two-step rotation — see §9 below |
| `DATASET_SHARING_ENABLED` | Kill switch for approved-access dataset sharing. Only the exact string `"true"` enables it; unset is dark. Redeploy after a change. See "Approved-access dataset sharing" |
| `DATASET_WATERMARK_SECRET` | Key for the per-grant watermark. At least 32 characters after trimming. **Never rotate it**: every shipped edition's grant order depends on it |
| `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID` | Private Vercel Blob store for edition files: either the token, or OIDC with `BLOB_STORE_ID`. Keep the token in `.env.local` for local runs |

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

⚠️ **Turning it off is a redeploy, then a Cloudflare purge.** Vercel applies an env change to
new deployments only, so unsetting the variable does nothing until
`npx vercel redeploy --target production <url>` is READY. The email field follows that same deploy:
`/contribute` is prerendered at build, and the correction dialog on facility pages and `/gaps` (ISR)
gets the flag from the page render via `CorrectionNotifyProvider`; a new deployment gets its own ISR
cache, so it renders both without the field. Cloudflare can still serve HTML cached before the
deploy, so finish with `{ purge_everything: true }` and confirm with a fresh GET. Until then a visitor
can type an email the server silently ignores, which is why neither form's success copy promises one.

Two things were true before it was set to `"true"`, and stay true for any future re-enable:

1. **The migrations must be applied.** `drizzle/0011_*` and `drizzle/0012_*` create
   `submission_notify_requests` and `submission_notify_sends`. Nothing in CI runs
   `db:migrate`, and `scripts/check-schema-drift.ts` derives its expected-table list from the
   `pgTable` exports — so `schema-check.yml` (daily) goes red until Neon has both tables; `npm run check:schema` runs the same check by hand.
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

### `API_INTAKE_TOKEN`: the intake/admin split (declined 2026-10-28, narrowed for submissions)

`POST /api/submissions` accepts either `API_INTAKE_TOKEN` or `API_ADMIN_TOKEN` (`requireIntake` in
`lib/api-auth.ts`). The full split was declined on 2026-10-28: the discovery pipeline runs every tool
with `--env-file=.env.local`, and that file holds `DATABASE_URL` as the `neondb_owner` role, which can
write any row, including a live facility. Removing the pipeline's admin token alone narrowed nothing
that matters while the least-privilege DB split stays deferred (see "Secret rotation" step 1).

The scheduled run now submits with `API_INTAKE_TOKEN` only: `run.sh` sets
`DISCOVERY_REQUIRE_INTAKE_TOKEN=1`, `submit-candidates.ts` then refuses the admin fallback and exits 1
if the intake token is missing, and the token is set in Vercel production and `.env.local`. A manual
run with the flag unset (or `0`) still falls back to `API_ADMIN_TOKEN`. This narrows submissions, not
the whole pipeline.

Which pipeline tools still hold the owner credential (`scripts/discovery/db-client-import-guard.test.ts`
enforces the list): the leads lane writes (`createSubmission`, `updateLeadStatus`, `promoteLead`, all via
`lib/db/client` `getDb()` on `DATABASE_URL`), `publish-heartbeat.ts` upserts the heartbeat row, and
`scripts/retention-prune.ts` deletes. `check-heartbeat.ts` and `check-digest-status.ts` also use
`getDb()`, but run in CI (`discovery-watchdog.yml`) on the `DATABASE_URL` Actions secret, which is moving to
the read-only `ci_monitor` role. A scoped staging role for the leads lane is a possible follow-up, not
planned.

A revisit needs both: a scoped Neon role for the pipeline, and `run.sh` reading its own env file,
because `.env.local` is shared with `npm run submissions` (which needs `API_ADMIN_TOKEN` for every
subcommand) and with `db:sync --apply`'s tag bust.

⚠️ `API_INTAKE_TOKEN` must be an independent value. Equal to `API_ADMIN_TOKEN`, it
gives no separation at all.

## Secret rotation

As of the 2026-09-27 security audit, nothing in this project had ever been rotated — every Vercel
variable still had `createdAt == updatedAt`, oldest 76 days. Rotations have happened since; the log
below is the current record. This is the runbook; work **top to bottom**, because the order matters
in two places.

⚠️ **A new or changed Vercel env var is invisible to already-built deployments.** Vercel injects env
at deploy time, so every rotation below needs
`npx vercel redeploy --target production <url>` before it takes effect. A rotation that "didn't work"
is usually a missing redeploy.

**Rotation log** (names and dates only; secret values are never recorded here):

| Date (EDT) | Secret | Note |
|---|---|---|
| 2026-10-27 ~08:25 | `API_ADMIN_TOKEN` | rotated |
| 2026-10-27 ~09:25 | `NEON_API_KEY` | revoked, not rotated (step 0) |
| 2026-10-27 ~11:50 | `RESEND_API_KEY` | rotated |
| 2026-10-27 ~17:30–17:52 | `DATABASE_URL` + `DATABASE_URL_UNPOOLED` (`neondb_owner`) | rotated (step 1); the one pre-reset Neon preview child branch deleted; verified by `check:drift` and a `drift-alert` dispatch |

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
update Vercel production `DATABASE_URL` (the **pooled** string, `-pooler` host) and
`DATABASE_URL_UNPOOLED` (the **direct** string) → **redeploy** → update `.env.local` (direct) → update
the GitHub `DATABASE_URL` secret (direct) → delete any Neon child branch created before the reset
(below) → `npm run check:schema` to confirm the connection.
Breaks if you do it out of order: `db:sync`, `db:export`, `check:schema`,
`discovery-watchdog.yml` and `schema-check.yml`, all at once.

⚠️ **No code reads `DATABASE_URL_UNPOOLED`** (the Neon integration creates it). It is a second copy
of the same credential — rotate it in lockstep or remove it. Being integration-managed, it refuses
`vercel env update … --sensitive` ("You cannot change the type of an integration Environment Variable
to Sensitive"); update it without `--sensitive`. A non-sensitive variable can be read back (dashboard,
`vercel env pull`), which is one more reason to remove it if the integration allows that.

⚠️ **Preview child branches keep the OLD password.** Neon password resets are branch-scoped. On
2026-10-27 the Neon integration had created a child branch for a preview deployment (a copy of
production data), with matching branch-scoped Preview variables in Vercel. That branch still accepted
the old password after the reset. List the project's branches after every rotation and delete any
child branch created before the reset. Deleting it also removed its Preview variables. Whether the
integration recreates the branch on the next preview deploy was not observed.

⚠️ **Clipboard trap:** copying a command in order to paste it replaces the connection string on the
clipboard, so a `pbpaste > file` step saves the command instead. In a real terminal, paste the string
into a hidden prompt instead. Run this once as written, `f=pooled` (the string for Vercel's
`DATABASE_URL`), then again with the first assignment changed to `f=direct` (the string for Vercel's
`DATABASE_URL_UNPOOLED`, `.env.local` and the GitHub secret; see the `DATABASE_URL` row in the env table):
`(f=pooled; umask 077; mkdir -p -m 700 ~/.rot; read -rs c; printf '%s' "$c" > ~/.rot/$f; unset c)`
(a subshell, so the umask doesn't stick; a folder outside the repo). Then check each file's shape
without printing it, e.g. for `pooled`: `head -c 13 ~/.rot/pooled` shows `postgresql://`,
`grep -c "[\"']" ~/.rot/pooled` shows `0` (no quotes of either kind; see the `.env.local` quoting gotcha in
CLAUDE.md), and `grep -c -- -pooler ~/.rot/pooled` shows `1` (the same check on `~/.rot/direct` must
show `0`). Delete `~/.rot` when done.

**2. `API_ADMIN_TOKEN`.** Grants every admin write route, the admin UI, the cron recovery path, and
manual discovery staging writes too (the scheduled run submits with `API_INTAKE_TOKEN`). ⚠️ **Rotating it invalidates
every live `admin_session` cookie**, because the cookie HMAC key is HKDF-derived from the token
(`lib/admin-session.ts`, `deriveSessionKey`). There is **no overlap window** — the code compares against
exactly one value, so it is a hard cutover.
Order: Vercel production → **redeploy** → `.env.local` (the `submissions` CLI, `sync-to-neon.ts` and
`submit-candidates.ts` all read it) → log in to `/admin` again.
Do it when **no nightly `run.sh` discovery run is in flight**.
The scheduled discovery run submits with `API_INTAKE_TOKEN`, but its `.env.local` still holds
`API_ADMIN_TOKEN` for manual runs and the other CLIs, so it is part of this rotation, and the
in-flight-run caveat above applies.

**Sign out everywhere (without rotating the token).** The session cookie (`v3.<issuedAtMs>.<nonce>.<hmac>`) is
signed with an HKDF-SHA256 key derived from `API_ADMIN_TOKEN` plus the optional env `ADMIN_SESSION_EPOCH`
(unset = `"0"`). Logout only clears the browser's cookie; a stolen cookie stays valid for up to 7 days. To
revoke every outstanding session: set or bump `ADMIN_SESSION_EPOCH` (any new string, e.g. `1`, `2`) in
Vercel production → **redeploy** (Vercel env applies to new deployments only) → log in again. The bearer
token and password are unchanged. The `v2` to `v3` cutover itself signed everyone out once. The login
brute-force cap (5 failed attempts / 15 min per IPv4 address or IPv6 /64, hashed) is durable in
`intake_attempts` under surface `admin-login`. Each attempt reserves a row before the password is checked
and the row is deleted on success, so concurrent guesses (also across instances) can never exceed the cap; a simultaneous burst may be refused entirely. It fails closed if the DB is unreachable, so a Neon outage also blocks admin login. Residual:
if the post-success delete fails, that login still succeeds but the row counts as a failure.

**3. `NEON_SYNC_PAT`.** Unused: no surviving workflow reads it (`neon-sync` and `nhd-backfill` were
deleted). Revoke it in GitHub when convenient. (It was used only by `neon-sync.yml` and `nhd-backfill.yml`, both deleted in PR C; it had no Workflows scope by design and was due to expire 2026-12-04.) The `DATABASE_URL` Actions secret is still used by
`discovery-watchdog.yml` and `schema-check.yml`; do not remove it.

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
It also salts the `email_sends` address hashes (see the env table). After a rotation, `npm run email-sends -- --email -` and `/admin/email-sends` find nothing for an address whose sends were recorded under the old salt.

**8. `INDEXNOW_KEY`.** Public by design. If changed, write the new `public/<key>.txt` and delete the
old one in the same commit — `indexnow.test.ts` asserts the file matches the constant.

**9. `EDGE_SHARED_SECRET` — ⚠️ the gate is ARMED and FAIL-CLOSED; rotation always costs a 403 window unless Option B is built first.**
An earlier version of this section said rotation was "safe in either order because the check is
fail-open when unset." That was only true before the gate was armed, and it would have prescribed
exactly the outage it warned about (corrected 2026-09-27). Since 2026-10-15 it is no longer true in
a second way: the code is fail-closed.

**State today (2026-10-15).**
- **ARMED** (since 2026-09-27): the variable holds a value and a deploy has read it, so
  `isEdgeOriginAllowed` refuses any request without a matching header.
- **FAIL-CLOSED** (since 2026-10-15, activation step 4): `if (!expected) return false;`. Unsetting or
  emptying the variable on production does not disarm anything; it 403s every matched path.
- **Matched paths** (activation step 5, same day): `/admin`, `/api` (except `/api/cron/*`), `/map`,
  `/data`, `/table`, `/facilities/*`, `/embed/*`. A 403 on `/map` is a user-visible outage, not a quiet API failure.

`isEdgeOriginAllowed` compares the presented header against **one** value. So:
- Change the Cloudflare rule first ⇒ presented(new) ≠ expected(old) ⇒ **403**.
- Change Vercel first ⇒ the running deployment still holds the old value (env is read at deploy
  time), so nothing changes until the redeploy, then presented(old) ≠ expected(new) ⇒ **403**.

**Option A — three phases with an unset step. ⛔ SUPERSEDED 2026-10-15; do not use.** Its first step
(unset the variable, redeploy) relied on the code failing open. It is now an outage on the
matched paths for as long as the variable stays unset. Kept for history only.

**Option C — short 403 window, no code change (current procedure).** Do it at a low-traffic hour.
1. Replace `EDGE_SHARED_SECRET` in Vercel (production scope) via `vercel env update EDGE_SHARED_SECRET
   production`, pasting the new value at the prompt (stdin; never `--value`, the command line or shell
   history). Inert until a redeploy. Use `update`, not `rm` + `add`: between those two the variable is
   absent, so any deploy in that gap 403s the matched paths.
2. `npx vercel redeploy --target production <url>` and wait for READY.
3. IMMEDIATELY change the Cloudflare Transform Rule (`x-edge-shared-secret`) to the new value.

The 403 window on the matched paths runs from the moment the new deployment takes the production
alias until the Cloudflare change lands: seconds if step 3 follows at once, not the whole build.

Side effects to know:
- An instant rollback or promote of an older deployment re-arms the OLD secret and 403s the matched
  paths until Cloudflare matches it again.
- Any production deploy or env change that drops the variable is now an outage on those paths, not a
  quiet disarm.

Verify with real GETs. Through the normal hostname, `/map` and `/api/stats` must be 200. Each of
these must 403 via `curl --resolve 'www.compute-atlas.com:443:76.76.21.21' https://www.compute-atlas.com<path>`:
`/map`, `/map.rsc` (the 5.8 MB RSC payload), `/%6Dap` (percent-encoded `/map`, which the origin
decodes), `/api/stats`. A 403 from this gate looks like any other 403; do not infer success from the
absence of errors.

**Option B — accept an overlap, needs a code change; now the only zero-downtime path.** Have
`EDGE_SHARED_SECRET` parse a comma-separated list and accept any member (still `timingSafeEqual` per
candidate, constant work per request). Then: add the new value alongside the old → redeploy → change
the Cloudflare rule → remove the old value → redeploy. No window. Build this first if rotation is ever
expected to be routine.

Either way: **verify with a real GET, not by absence of errors** — a 403 from this gate looks identical
to any other 403, and Cloudflare could cache it (`proxy.ts` sets `no-store` on that response for
exactly this reason).

## Contact messages: reply as Compute Atlas, never from your inbox

The site is cited by third parties, so no correspondence may carry the maintainer's personal address.

- `/api/contact` stores the message and notifies `CONTACT_TO_EMAIL` **without** a `Reply-To`, so pressing
  Reply in your inbox goes back to the Compute Atlas sender (`EMAIL_FROM`), never to the visitor. Do not re-add it.
- Answer from **`/admin/contact` → "Reply as Compute Atlas"**. It sends via Resend from `EMAIL_FROM`, and
  refuses to send unless that address is `@compute-atlas.com`.
- ⚠️ **The one gap code cannot close:** a visitor's follow-up goes to `alerts@`, which Cloudflare Email
  Routing forwards into your inbox *with the visitor as sender*. Replying there sends from your personal
  address. Answer follow-ups from the original message's reply box in `/admin/contact` instead.

## Releases

The project follows [Semantic Versioning](https://semver.org). Releases are published via
[GitHub Releases](https://github.com/ek33450505/compute-atlas/releases) and automated with
release-please; see [CHANGELOG.md](../CHANGELOG.md).

The final open edition (`data/facilities.json`, 3,025 records) is frozen at older commits; the
file is no longer tracked. Its `asOf` timestamp in `data/facilities.meta.json` records when a
snapshot was generated.

## Accepted dependency advisories

`npm audit` is not a CI gate. Any finding left open is recorded here with its reason, and is
re-checked when its trigger fires. Never run `npm audit fix --force`. Bumps follow the 14-day
publish-age floor (`npm update <pkg> --before=<today minus 14 days>`).

No advisory is currently accepted: `npm audit` reports 0 vulnerabilities (2026-10-26).

Resolved: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (`braces` ≤3.0.3,
dev-only, accepted 2026-10-21) was withdrawn by GitHub on 2026-10-23, so `npm audit` no longer
reports it. `braces` is still 3.0.3.

### Publish-age floor exceptions

Versions taken below the 14-day floor, with the reason. Each one is moot once it turns 14 days old.

| Version | Published | Age when merged | Why | Merged in | Accepted |
|---|---|---|---|---|---|
| `next` 16.4.3 | 2026-10-23 | 3 days | Two critical RCE advisories plus a high DoS (Dependabot #68, #69, #71; fixed in 16.4.1). Neither RCE path is used here (no `"use cache"`, no `next/image`). | #480 | 2026-10-26 (Ed) |
| `fast-uri` 3.1.9 | 2026-10-19 | 7 days | Dev-only; four advisories (#74–#77). Came with #480. | #480 | 2026-10-26 (Ed) |
| `undici` 7.30.1 | 2026-10-15 | 11 days | One high, two moderate advisories (#78–#80); imported only by `scripts/discovery/net-guard.ts`. | #482 | 2026-10-26 (Ed) |
| `vitest` / `@vitest/mocker` 4.1.12 | 2026-10-15 | 11 days | Dev-only; two moderate advisories (#66, #67). | #482 | 2026-10-26 (Ed) |
| `body-parser` 2.4.0 | 2026-10-22 | 4 days | Dev-only (via the `shadcn` CLI); high DoS (GHSA-27r3-jxmh-p828). From `npm audit fix`. | #482 | 2026-10-26 (Ed) |
| `ip-address` 10.7.5 | 2026-10-25 | 1 day | Dev-only (via the `shadcn` CLI and `socks`); moderate (GHSA-rxp7-6hxx-x8q5). From `npm audit fix`. | #482 | 2026-10-26 (Ed) |

The floor was not checked before these merged; the exception was recorded afterwards. Checked on
2026-10-26: `npm audit signatures --include-attestations` verified registry signatures for all
877 installed packages, and each version above carries a provenance attestation (built and
published by its project's own GitHub Actions). That covers a hijacked maintainer account
publishing by hand, but not a compromised CI pipeline.

## Builds are gated, production included

`vercel.json` runs `scripts/vercel-ignore-build.sh` as Vercel's Ignored Build Step. Any
deployment whose diff touches only `docs/`, `.github/`, `*.md`, `LICENSE` or `LICENSE-DATA` is
skipped — production too, because `db:sync` puts data live in Neon before any commit is merged. No
`data/` file is allowlisted (the data files are untracked), so a diff touching `data/` builds. Changed
paths are listed with `--no-renames`, so a rename of code into `docs/` still builds. A production
build can be forced with `npx vercel redeploy --target production`.

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

## Subscriber notifications and unsubscribe links

- **Unsubscribe links are bearer tokens.** Anyone holding a forwarded email can unsubscribe
  that watch or stop all automated email for the address. "Stop all automated email" keeps the FIRST
  stop-all's token (`email_suppressions.source_token_hash`) as the only one that can undo
  it; a later stop-all from another token is not undoable by that token.

**Did this address get our mail?** Look it up in the send ledger (`email_sends`, one row per email
attempt). Either form works; both need `CONTRIBUTE_IP_SALT` set to production's value, and the CLI
exits 2 without it rather than hash with the public default salt:

```bash
printf '%s' 'addr@example.com' | npm run email-sends -- --email -
```

Use `--email -`, not `--email <addr>`: the latter leaves the address in shell history. Or open
`/admin/email-sends`. The CLI is read-only and never prints the address. Narrow with `--kind`,
`--outcome`, `--since YYYY-MM-DD` and `--limit N`. `--run <uuid>` shows one digest run, where the
uuid is a `state_digest_runs` id.

Outcomes (`EMAIL_SEND_OUTCOMES` in `lib/email-sends.ts`; meanings from `lib/email-gate.ts`):

| Outcome | Meaning |
|---|---|
| `attempted` | Claimed before the send. Left here when the settle write failed or the process died mid-send, so the mail **may already have gone out**: `attempted` does not mean "not mailed". Counts toward the confirm cap |
| `sent` | The sender reported success |
| `error` | The send failed or threw; `error_code` says why. Counts toward the confirm cap |
| `skipped_no_key` | No API key: nothing was mailed |
| `skipped_suppressed` | A global or per-target suppression covers the address |
| `skipped_unconfirmed` | The row is missing, the address does not match, or the row is not in the state this mail requires (a confirmed row asked for a confirm mail lands here too) |
| `skipped_duplicate` | A deduped maintainer alert: a `sent` row for the same reason and target already exists, so the alert was not mailed again |
| `skipped_capped` | The per-address confirm cap (10 per 30 days) was exceeded: the 11th confirm attempt in the window is the first one skipped |
| `skipped_check_failed` | The suppression lookup errored. Not sent, and NOT a suppression |

`error_code = "covered_row"` means a digest email was skipped because a covered row (one of the
watches the email lists) failed its own check, not the anchor row. The row records that covered
subscription's id, target type and target id; the id is null if the row was deleted meanwhile. An
anchor failure carries no `covered_row` code.

**Turning county and metro watching off.** Set `WATCH_AREAS_ENABLED=false` and redeploy. From the new
deployment on, the API rejects county and metro subscriptions. The county and metro hub pages that
render the watch form are ISR-cached (86400s, `"facilities"` tag), so the form can keep showing there
until the page regenerates (its 24h timer, or a `"facilities"` bust such as the next `db:sync --apply`),
and Cloudflare may serve its own copy for longer. Submitting it returns the rejection. To make it
immediate, bust `"facilities"` via the admin `POST /api/revalidate`, then purge Cloudflare with
`purge_everything` (purge-by-URL does not evict here; see CLAUDE.md). Existing county and metro
subscriptions are kept, not mailed: while the switch is off the monthly digest reads only state rows
and logs one info line per run. Turning it back on is the same change in reverse.

## Approved-access dataset sharing

The lane is dark until `DATASET_SHARING_ENABLED` is exactly `"true"` (`lib/dataset-flag.ts`). Access is
free, and Ed approves every grant by hand in `/admin/access`. It is the only sanctioned file route: public
bulk download, bulk API and per-record JSON stay closed, and every file is watermarked to one grant.

Flow: `/access` request form → `/access/confirm` (the verify step is a form POST to
`/api/access/confirm`, so a mail scanner's GET prefetch cannot confirm) → `pending_review` → approve or
reject in `/admin/access` → approval mail with the personal link `/access/dataset?t=…` → weekly edition
(`vercel.json`) → downloads from `/api/dataset/file` → weekly notice mail → renewal reminders → one-click
unsubscribe at `/api/dataset/unsubscribe`. A grant runs 365 days (`DATASET_GRANT_TERM_MS`,
`lib/dataset-grants.ts`).

### Kill switch and redeploy

- Unset `DATASET_SHARING_ENABLED` (any value but `"true"` is also off) and redeploy with
  `npx vercel redeploy --target production <url>`. Vercel applies env changes to new deployments only.
- `/access`, `/dataset`, `/data` and `/contact` read the flag at build time (`app/access/page.tsx` says so; `/dataset` and
  `/contact` show the "Request access" link only when it is on, and so does the site footer's "Free access for
  education" link on every page, `lib/site-nav.ts` via `components/site-footer.tsx`), so a flip takes effect with the redeploy's
  build; ISR revalidation alone never picks it up, because the old deployment never sees the new value. The
  `/access/*` token pages are dynamic and read it per request, except the unsubscribe pages
  (`/access/unsubscribe`, `/access/unsubscribed`), which never read it so an opt-out works with the flag off.
- With the flag off:
  - the cron route returns `skipped: disabled` and builds nothing (`app/api/cron/dataset-edition/route.ts`);
  - admin "Build now" still builds an edition, but sends no mail (`sendScheduledMail` in
    `lib/dataset-edition-builder.ts`);
  - `/access` renders a noindexed "not open yet" page (`app/access/page.tsx`, `app/access/not-open.tsx`);
  - `/api/dataset/unsubscribe` keeps working, because it does not check the flag. An opt-out must not depend
    on a switch.

### Blob store and secrets

- Edition files live in a **private** Vercel Blob store (`lib/dataset-blob.ts`). Auth is either
  `BLOB_READ_WRITE_TOKEN`, or OIDC with `BLOB_STORE_ID`. Keep `BLOB_READ_WRITE_TOKEN` set in
  `.env.local` for local runs: without it the SDK's OIDC path reads the Vercel CLI's stored login
  (`node_modules/@vercel/oidc/dist/token.js`).
- `DATASET_WATERMARK_SECRET` must be at least 32 characters after trimming whitespace
  (`lib/dataset-download.ts`, `MIN_WATERMARK_SECRET_LENGTH`). If it is missing or short, the two record
  files are refused with a 503, never served unmarked.
- **Never rotate `DATASET_WATERMARK_SECRET`, and never change the algorithm in
  `lib/dataset-watermark.ts`.** The grant order is recomputed from the secret when a leak is traced. A new
  secret or algorithm makes every shipped edition untraceable.
- The watermark is a row-order permutation of `facilities.json` and `facilities.csv`. It is a design
  limit that re-sorting a leaked file removes it: `scripts/dataset-trace.ts` measured a re-sorted file at
  about 0.02 for every grant. `siting-context.json`, `changelog.json` and `README.txt` are not watermarked.
- `CRON_SECRET` must have no surrounding whitespace in Vercel. The presented bearer is trimmed; the stored
  secret is compared exactly (`lib/cron-auth.ts`).

### Cron, builds and the Resend cap

- The edition cron is `0 14 * * 5`: Friday 14:00 UTC, `/api/cron/dataset-edition` (`vercel.json`).
  The route and the `/admin/access` page both set `maxDuration = 300`. The route's own comment calls 300 s
  the Pro-plan ceiling, so confirm the project's Vercel plan still allows it.
- The cron ignores the 5-minute retry cooldown, but the schedule fires once a week and nothing reruns a
  failed build. After a failed Friday build, run **Build now** in `/admin/access`.
- After a build, renewal reminders are sent first, then the weekly notice, paced 600 ms apart with a 240 s
  budget and a 20 s timeout per send (`lib/dataset-notices.ts`).
- **Resend Free allows 100 mails a day across all mail**, including verify, admin, approval, reminder and
  notice mail. The notice file's own estimate is that with more than about 80 live grantees, some notices
  hit the daily cap. A failed notice is not retried (the send is claimed first), so that grantee misses that
  week's notice. Upgrading the Resend plan removes the ceiling; no code change is needed.
- A notice pass cut short by the budget, or by a database error, shows **Incomplete** in the Editions panel.
  **Build now** the same day, while that edition is still the newest published one, resumes it. Only
  grantees not yet claimed are mailed.

### Reviewing requests, reissue, revoke, extend

- Approve or reject a request, or a renewal, in `/admin/access`. Approval mails the personal link. A renewal
  approval sends no mail.
- **Reissue** mails a new link and makes the old one stop working. Each grant has a 10-minute cooldown
  (`DATASET_REISSUE_COOLDOWN_MS`, `lib/dataset-admin.ts`).
- **Revoke** makes the link stop working and sends no mail (Ed, 2026-11-09: there is no revoke notice).
- **Extend** gives a fresh 365-day term (`DATASET_GRANT_TERM_MS`, `lib/dataset-grants.ts`) and sends no mail.

### Retention

The retention periods are quoted to requesters in `DATASET_PRIVACY_NOTICE` (`lib/dataset-terms.ts`), and
the `DATASET_*_RETENTION_DAYS` constants in `scripts/retention-prune.ts` implement them. Change the notice
and the constants together. Summary:

| Data | Kept for |
|---|---|
| Unverified requests | 7 days |
| Rejected requests | 180 days after review |
| Revoked or expired grants, with their download rows | 365 days after revocation or expiry |
| Hashed IP on a request | cleared 90 days after review |
| Download rows | 365 days |
| Retention backup files (deleted rows) | 30 days |
| Hashed IP on a download row | cleared 90 days after the download |
| Email send log (`email_sends`) | 180 days |

- The prune runs in the discovery lane (`scripts/discovery/run.sh`, `retention-prune.ts --apply`), which
  runs Mon-Fri at 13:00 local (Mon/Wed/Fri until 2026-11-12), and only when `DISCOVERY_ENABLED=true` (`run.sh` exits before any lane
  otherwise). A deletion lands on the first run that reaches the prune step after its period: up to 3 days
  late when runs complete, later if a run exits early (e.g. a config check in `run.sh`).
- ⚠️ **Deleted rows are copied, then the copies expire.** Before each deletion or hashed-IP clearing the prune writes the
  candidate rows (cleared-IP rows included, and the notice says so) as JSON lines to `discovery-logs/retention-backups/` (`appendBackup` in `scripts/retention-prune.ts`); those copies can
  include request emails and names. The same prune run deletes backup files 30 days after their creation
  (`RETENTION_BACKUP_RETENTION_DAYS`, by the filename timestamp, regular files matching the run's own naming only),
  and the privacy notice says so (Ed, 2026-11-09).
- A download-log write failure does not block the download. The log fails **open** (`lib/dataset-download.ts`).
- Per-address mail caps: `lib/email-gate.ts`, with the limits in `lib/email-sends.ts`.
- The terms and privacy notice are final (version `2026-11-11.2`). Ed decided on 2026-11-09 not to seek legal review. Bump `DATASET_TERMS_VERSION` in `lib/dataset-grants.ts` whenever their text changes.

### Tracing a leaked file

```bash
npm run dataset:trace -- <file> --edition <YYYY-MM-DD|uuid>
```

`scripts/dataset-trace.ts` ranks each grant by how closely the file's row order matches that grant's
watermark. It needs `DATABASE_URL`, `DATASET_WATERMARK_SECRET` and the Blob env in `.env.local`. It is
read-only: the only database access is `select`. A score is evidence for a person to review, not proof.
A re-sorted file scores near zero for every grant (see the watermark limit above).

### Paid tier: setup and policy

`COMMERCIAL_TIER_ENABLED` (exact string `"true"`, `lib/commercial-flag.ts`) gates the commercial checkout and the
PayPal webhook. The return page needs both flags, like checkout. Unset, they are off: the webhook answers 403
(`app/api/paypal/webhook/route.ts`). A missing PayPal value makes the webhook log `config=<VARIABLE>` and answer 500.
Checkout logs `commercial-checkout PayPal call failed (config)` and sends the buyer back with `?error=unavailable`.
The commercial pages and checkout require BOTH
`COMMERCIAL_TIER_ENABLED` and `DATASET_SHARING_ENABLED` (`isCommercialCheckoutOpen()` in `lib/commercial-flag.ts`).
The webhook needs only the tier flag, so money already taken is still processed after checkout is closed.

Env vars (all in `.env.example`):

| Variable | Value |
| --- | --- |
| `COMMERCIAL_TIER_ENABLED` | `true` to turn the tier on |
| `PAYPAL_ENV` | `live` or `sandbox` (anything else throws `config=PAYPAL_ENV`) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | the REST app's credentials for that environment |
| `PAYPAL_WEBHOOK_ID` | id of the webhook created below (needed to verify signatures) |
| `PAYPAL_PLAN_COMMERCIAL_MONTHLY`, `PAYPAL_PLAN_COMMERCIAL_ANNUAL` | the two plan ids (`P-...`) |
| `COMMERCIAL_RETURN_BASE_URL` | optional: origin PayPal returns buyers to; previews only (defaults to the site URL) |

Vercel applies env changes to new deployments only: redeploy after any change.

Decisions (Ed, 2026-11-11): payments go through PayPal and a PayPal account is required; $150/month or $1,500/year
plus applicable tax (Ed handles sales tax himself; there is no tax engine); buyers are never refused on who they are (the data is
CC BY 4.0): a revoked buyer may subscribe again, and a duplicate subscription gets no second grant and alerts you when its payment lands; no
automatic refunds anywhere. Tax must not be added to the PayPal charge: activation requires the payment to equal the
plan price exactly (`lib/commercial-activation.ts:270`), so a different charge is not activated and raises an
`unmatched_subscription` alert. The public terms (`lib/dataset-terms.ts`, version `2026-11-11.2`) say the
same. Changing their text means bumping `DATASET_TERMS_VERSION` in `lib/dataset-grants.ts`. Seats were dropped
(2026-11-10): one named person per subscription, the personal link is strictly personal, teams by arrangement
through `/contact`. Free access is for students, educators and academics only (Ed, 2026-11-11), separate and
hand-reviewed; everyone else, journalists and nonprofits included, is pointed to the commercial tier.

PayPal setup (a live REST app under Ed's business account; do the sandbox first with `PAYPAL_ENV=sandbox` and
`https://api-m.sandbox.paypal.com`). The product and plan calls below follow the PayPal Subscriptions REST API
reference; `lib/paypal.ts` never creates products or plans, so the product and plan request bodies below are not
exercised by the repo's tests: check the response of each.

```bash
BASE=https://api-m.paypal.com   # sandbox: https://api-m.sandbox.paypal.com
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$BASE/v1/oauth2/token" | jq -r .access_token)

# 1. One product
curl -s -X POST "$BASE/v1/catalogs/products" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Compute Atlas commercial dataset access","type":"DIGITAL","category":"SOFTWARE"}'
# -> note "id" as <PRODUCT_ID>

# 2. Monthly plan ($150) and annual plan ($1,500): infinite cycles (total_cycles 0), no trial, no setup fee
curl -s -X POST "$BASE/v1/billing/plans" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"product_id":"<PRODUCT_ID>","name":"Commercial monthly","status":"ACTIVE",
       "billing_cycles":[{"frequency":{"interval_unit":"MONTH","interval_count":1},"tenure_type":"REGULAR","sequence":1,"total_cycles":0,
                          "pricing_scheme":{"fixed_price":{"value":"150.00","currency_code":"USD"}}}],
       "payment_preferences":{"auto_bill_outstanding":true,"setup_fee_failure_action":"CANCEL","payment_failure_threshold":3}}'
# -> "id" is PAYPAL_PLAN_COMMERCIAL_MONTHLY. Repeat with name "Commercial annual", interval_unit YEAR, value "1500.00"
#    -> "id" is PAYPAL_PLAN_COMMERCIAL_ANNUAL.
```

Webhook: URL `https://www.compute-atlas.com/api/paypal/webhook`, subscribed to exactly the events
`processPaypalEvent` handles (`lib/commercial-activation.ts`, the `switch` in `resolveEvent`; any other event type is
recorded and ignored):

- `BILLING.SUBSCRIPTION.ACTIVATED`: activates the grant (first activation path).
- `PAYMENT.SALE.COMPLETED`: activates a grant that does not exist yet, or extends `paid_through` on renewal. Status,
  plan and payment time come from a re-fetch of the subscription, never from the event body.
- `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`: write nothing;
  access runs to `paid_through`.
- `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`: alert `payment_reversed`; nothing is changed or refunded.
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED`: logged only; access runs to `paid_through`.

Create it in the developer dashboard (Apps & Credentials, your app, Webhooks) or with
`POST $BASE/v1/notifications/webhooks` and `{"url":"https://www.compute-atlas.com/api/paypal/webhook","event_types":[{"name":"BILLING.SUBSCRIPTION.ACTIVATED"}, ...]}`
listing those eight names. Its `id` is `PAYPAL_WEBHOOK_ID`.

Ship order (the webhook id does not exist until the webhook does, and the webhook 403s while the flag is off):

1. Set `PAYPAL_ENV=live`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and the two plan ids in Vercel production. Leave
   `COMMERCIAL_TIER_ENABLED` unset. Redeploy.
2. Create the live webhook (above). Put its id in `PAYPAL_WEBHOOK_ID`. Redeploy.
3. Set `COMMERCIAL_TIER_ENABLED=true`. Redeploy.
4. Ship-day Cloudflare check: send a test event from the dashboard's webhook simulator (or make one real
   subscription) to the live `www` URL and confirm PayPal records a 200 delivery and a row appears in
   `paypal_webhook_events`. The route sits behind `proxy.ts`'s edge secret, so deliveries must come through
   Cloudflare. If Cloudflare blocks PayPal (a bot or UA rule), a skip rule is a Cloudflare change and needs
   Ed's explicit go; do not edit the rules without it. Simulator events may fail signature verification (a 400 from the route is
   possible); the check is that the request reaches the route and is not blocked by Cloudflare (403 or a challenge page).
5. Rotating `EDGE_SHARED_SECRET` breaks webhooks (403 from `proxy.ts`) until Cloudflare's injected header is updated.

Sandbox and previews: use `PAYPAL_ENV=sandbox` with sandbox credentials, sandbox plan ids and a sandbox webhook.
Set `COMMERCIAL_RETURN_BASE_URL` to the preview's own URL (https, or http on loopback) so PayPal returns the buyer
there (`checkoutReturnBase()` in `lib/commercial-checkout.ts`). Previews bypass Cloudflare, so a preview webhook needs
no skip rule.

Cancellation (the public terms): a buyer cancels from the download page (`lib/commercial-cancel.ts`,
`app/api/access/subscription/cancel`) or in PayPal's automatic-payments settings, and keeps access to the end of the
paid period (`paid_through` is left alone). No refunds for partial periods except where the law requires one; you may
refund at your discretion, by hand in PayPal. Nothing in the code refunds.

### Paid tier: alerts, revoke and refunds

Maintainer alerts come from `CONTACT_TO_EMAIL` ("Compute Atlas commercial subscription needs attention";
`lib/dataset-email-templates.ts`). The alert never moves money. By reason:

- `duplicate_subscription`: the buyer's email already holds a live commercial grant from another subscription, so no
  second grant was created. The alert arrives when PayPal reports the payment (one per charge on the duplicate
  subscription), not at checkout. Cancel the new subscription and refund its payment by hand in PayPal, unless they
  meant to buy twice.
- `unmatched_subscription`: an ACTIVE PayPal subscription could not be matched to a checkout, or its plan, first payment or next billing date did not match that checkout. Look it up in PayPal
  by the subscription id in the alert; decide whether to cancel/refund it or create access by hand.
- `payment_reversed`: PayPal reported a refund or reversal of a sale. Check the grant and the sale in PayPal. Access
  runs to `paid_through`; revoke the grant in `/admin/access` if it should end now.
- `revoked_still_billing`: a payment arrived for a revoked grant. Nothing was extended. Cancel the subscription in
  PayPal if the revoke did not, and refund that payment if you want to.
- `welcome_mail_undeliverable`: the buyer paid but the personal link was not mailed (address opted out of our email, or
  the grant was not live). Check the grant in `/admin/access`. Reissue the link there only if the address is not
  opted out. If it is opted out, refund and cancel in PayPal, or reach the buyer through their PayPal receipt.

Revoke:

- Buyers are never refused on who they are: a revoked buyer may subscribe again. A duplicate subscription gets no second grant, and you are alerted when its payment lands.
- **Admin revoke cancels the PayPal subscription (Ed, 2026-11-10).** Revoking a commercial grant in `/admin/access`
  revokes it in the database first, then cancels its PayPal subscription at once (`lib/commercial-revoke.ts`). It never
  refunds: refund by hand in PayPal if you want to. If the result line says the subscription could not be cancelled,
  the grant is revoked but billing continues: cancel it in PayPal now. A later payment for it raises the
  `revoked_still_billing` alert and is never extended.
- The per-grant watermark traces leaks: if the file leaks again, revoke the new grant.
- Keep `COMMERCIAL_TIER_ENABLED` on while any subscription exists: with it off the webhook answers 403, PayPal retries
  for about 3 days and then drops the events, so renewals, and the alerts above, are lost. Replay missed events from
  the PayPal developer dashboard (Webhooks events) if it was off.
- Checkout refuses to start (the buyer is sent back to the page with `?error=unavailable`) unless both
  `CONTACT_TO_EMAIL` and `RESEND_API_KEY` are set, so money is never taken while the maintainer alert cannot be sent
  (`app/api/access/checkout/route.ts`).
- Backstop: at most 300 checkouts per hour that have a PayPal subscription id and are not yet activated across the whole site
  (`COMMERCIAL_CHECKOUT_GLOBAL_HOURLY_CAP`, `lib/commercial-checkout.ts`); past it the form says the service is busy.
  Checkouts and cancels are also rate limited per hashed IP.

Log codes worth watching in Vercel runtime logs (codes only, never bodies or addresses):

- `commercial-checkout global cap reached`: the 300/hour backstop tripped; look for abuse.
- `commercial grant has no last_payment_at (code: missing_last_payment_at)`: a commercial grant without a recorded
  last payment time, so a renewal cannot be proven newer; check the grant against PayPal.
- `paypal-webhook terminal (...)`: PayPal said a subscription does not exist for an event older than 2 hours; the
  event was dropped with a 200. Check it in PayPal.
- `paypal-webhook processing failed (...)` / `paypal-webhook verify failed (...)`: PayPal will redeliver; a run of
  them means a config, PayPal or database problem. `paypal-webhook signature not verified` is a 400 (forged or wrong
  `PAYPAL_WEBHOOK_ID`).

### Rollback SQL

Run in this order, children first. This deletes every grant, edition and download record. It does not
remove Blob objects. To stop the lane, use the kill switch, not this SQL.

```sql
DROP TABLE dataset_downloads;
DROP TABLE dataset_editions;
DROP TABLE dataset_access_grants;
```

`dataset_downloads` references both other tables, so it goes first. Migration `drizzle/0020_dataset_sharing_tables.sql`
creates the three tables.

Migration `drizzle/0021_commercial_tier.sql` adds the commercial tier. **Applying it (forward), in this order:**

1. The PR is approved and green.
2. Run `npm run db:migrate` (one transaction through the Neon websocket migrator).
3. Merge immediately and wait for the production build.

Why the order matters: 0021 drops the old `dataset_access_grants_open_email_idx`, and the code that is live until
step 3 finishes inserts free requests with `ON CONFLICT (email)`, which then fails with SQLSTATE 42P10. The new
code needs the `tier` column, so it cannot go first. Between step 2 and the new build going live only the free
request form fails; downloads, notices and admin keep working. Do it at a quiet time and avoid Mon-Fri
13:00-15:30 (the discovery runs).

`commercial_checkouts` is the checkout and decision record: our form writes one row per attempt before the buyer is sent
to PayPal (plan, email, name, organization, terms version; its id travels to PayPal as `custom_id`). The webhook sets
the PayPal subscription id, then the decision: `activate` (the subscription has, or already had, a grant) or `refuse`
(reason `duplicate_subscription`: the email already holds a live commercial grant, no second grant is made and you are
alerted when its payment lands). Nothing is cancelled or refunded for a refusal; you decide by hand in PayPal. Retention
(`scripts/retention-prune.ts`) deletes undecided rows after 30 days and nulls email, name and organization on decided
rows after 365 days; the decision record itself stays. `paypal_webhook_events` holds event ids and types; processed
rows are deleted after 90 days.

To undo only that migration
(keeps every grant; `paypal_webhook_events` and `commercial_checkouts` reference `dataset_access_grants`, so they go first):

1. Revert the deploy first, then disable the webhook in the PayPal developer dashboard, so redelivered events
   are not reprocessed once `paypal_webhook_events` is gone.
2. **Warning: once any commercial grant exists, this rollback destroys `paid_through`, `last_payment_at` and the PayPal subscription id.**
   Take a Neon branch first, or save the rows:
   `COPY (SELECT id, email, tier, paid_through, last_payment_at, paypal_subscription_id FROM dataset_access_grants WHERE tier='commercial') TO STDOUT`
3. **Check the old one-open-row-per-email index can be recreated.** 0021 replaced
   `dataset_access_grants_open_email_idx` with `dataset_access_grants_open_email_tier_idx` (unique on
   `(email, tier)`), so one address may now hold an open free AND an open commercial grant. Recreating the
   old index fails while that is true. Find the addresses:
   `SELECT email, array_agg(tier || ':' || status) FROM dataset_access_grants WHERE status IN ('unverified','pending_review','active') GROUP BY email HAVING count(*) > 1;`
   For each, expire or revoke one of the two rows (usually the commercial one, after refunding in PayPal)
   before continuing.
4. Run, in this order, back-to-back with the deploy revert (the old code's `ON CONFLICT (email)` fails until the
   old index is back):

```sql
BEGIN;
-- Revoke every commercial grant first: once `tier` is dropped the old code would read an unpaid commercial grant as a free one.
UPDATE dataset_access_grants SET status = 'revoked', revoked_at = now(), revoke_reason = 'commercial tier rolled back' WHERE tier = 'commercial' AND status <> 'revoked';
DROP TABLE IF EXISTS commercial_checkouts;
DROP TABLE IF EXISTS paypal_webhook_events;
DROP INDEX IF EXISTS dataset_access_grants_open_email_tier_idx;
CREATE UNIQUE INDEX "dataset_access_grants_open_email_idx" ON "dataset_access_grants" USING btree ("email") WHERE "dataset_access_grants"."status" in ('unverified', 'pending_review', 'active');
DROP INDEX IF EXISTS dataset_access_grants_paypal_subscription_id_idx;
ALTER TABLE dataset_access_grants
  DROP COLUMN IF EXISTS tier,
  DROP COLUMN IF EXISTS paid_through,
  DROP COLUMN IF EXISTS paypal_subscription_id,
  DROP COLUMN IF EXISTS last_payment_at;
-- Dropping `tier` also drops `dataset_access_grants_tier_check` (a single-column CHECK goes with its column).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794412790979;
COMMIT;
```

The last statement removes the migration's record (`created_at` is the 0021 `when` value in
`drizzle/meta/_journal.json`), so a later `npm run db:migrate` applies 0021 again.

### Production checks (O8)

Run these after a deploy with the flag on:

- `curl -s 'https://<prod>/access/dataset?t=x' | grep -c cloudflareinsights` must print `0`. The token pages
  send `Cache-Control: no-store, no-transform` (`proxy.ts`), so Cloudflare does not inject its analytics
  beacon, which would report the token-bearing URL.
- One real download of `facilities.json` (6.6–8.8 MB, above Vercel's 4.5 MB non-streamed limit, so the
  route streams it; see `lib/dataset-download.ts`) must complete.

## Supporters list

`lib/supporters.ts` (`SUPPORTERS`) names the people and organizations who support the atlas and asked to be named. It is opt-in only: add an entry by hand when a supporter says yes. An entry with `kind: "institution"` is listed for 12 months; remove it by hand when the year is up.

## Caching, briefly

Four surfaces. Three are Next.js render tiers, all reading from Neon:

- **Aggregate pages** (home, map, table, stats, explore) — 24-hour timer (home keeps 1 hour
  for its untagged activity reads), tagged `facilities`. Self-heal within a day even if a tag
  bust is missed.
- **Facility pages** — scoped tags only (`facility:<id>`, `operator:<slug>`, `state:<XX>`,
  plus `power-generation` where relevant), floored at 24 hours. A bust is how they refresh.
- **Search index** — 24-hour untagged timer. No tag bust reaches it.

The tag vocabulary lives in `lib/cache-tags.ts` and is shared by `lib/facility-write.ts`
and `POST /api/revalidate`, so producer and validator cannot drift apart.

The fourth is **Cloudflare's edge cache, and it is a security boundary** (audit s169,
2026-09-27). A cache rule makes **every GET whose path does not start with `/admin`**
eligible for the edge cache (`http_request_cache_settings`, `cache: true`,
`edge_ttl: respect_origin`) — the bearer-gated `/api/*` routes included. Two things
follow, and both are easy to get wrong:

- **`jsonResponse()` is `no-store` by default** (`lib/api-response.ts`) and must stay
  that way. It serves authenticated bodies (`GET /api/submissions` returns every staged
  row), writes, error bodies and 429s. It sets the directive under **both**
  `Cache-Control` and `CDN-Cache-Control`, because Cloudflare evaluates the latter
  first. Public reads are unaffected — they go through `cacheableJson()`, which is the
  only opt-in cacheable path.
- **A new GET under `/api/` has to decide this explicitly.** Mutating or token-bearing
  GETs emit `no-store`: `/api/cron/state-digest` mutates, and the `?token=` confirm,
  unsubscribe and access routes would otherwise put a single-use token in the cache key.

**Chicago-area visitors are served from Tokyo** (measured 2026-10-21; accepted, not fixable
on our plan). `/cdn-cgi/trace` on our hostname reads `colo=NRT` from Chicago-area networks,
with a TCP connect of 140–200 ms, while `www.cloudflare.com` from the same probes reads
`colo=ORD`. Sixteen Globalping probes elsewhere in the US all landed on a nearby colo. This is
Cloudflare's Free-plan routing; no setting we hold controls it, and the proxy cannot be turned
off because the edge-secret gate depends on it. Each colo keeps its own cache, so measure
cache behaviour with the colo in hand. (The `/data` CSV and JSON downloads this paragraph
once measured were removed in Phase 1, 2026-11-05: `/data` is now the "Cite & license" page
with no downloads, and the files are blocked at the edge.)

⚠️ Locally, a restart does **not** clear `.next/cache`, so a "fresh" dev server can replay
an ISR-cached page from before the last publish. That looks exactly like a stale data
snapshot but isn't — comparing data cannot see a stale *render*. Run
`rm -rf .next/cache` and re-fetch before concluding anything.

## CI database role (`ci_monitor`)

The `DATABASE_URL` GitHub Actions secret must hold the `ci_monitor` URL, not the owner credential. The role is `LOGIN`, read-only by default (`default_transaction_read_only`, 30s `statement_timeout`) and holds `SELECT` on `api_daily_usage`, `discovery_heartbeat` and `state_digest_runs` only: exactly what `schema-check` and `discovery-watchdog` read. `schema-check` lists tables through `pg_catalog.pg_tables`, because `information_schema` hides tables a role has no privilege on.

To (re)create or rotate it, with the owner `DATABASE_URL` in `.env.local`:

```bash
npm run ops:ci-monitor-role                      # dry run: prints the SQL plan, connects to nothing
D="$(mktemp -d)"                                         # fresh private directory; the tool refuses to overwrite
npm run ops:ci-monitor-role -- --apply --out "$D/ci.url" # add --rotate if the role exists
gh secret set DATABASE_URL -R ek33450505/compute-atlas < "$D/ci.url"
rm -rf "$D"                                              # delete the URL file once the secret is set
```

The URL file has no trailing newline (so `gh secret set < file` stores the URL exactly). The tool sends the generated password as a plain-text literal over TLS, because Neon rejects hashed passwords ([Neon: manage roles](https://neon.com/docs/manage/roles)). It writes the URL only to `--out` (mode 0600, never overwritten), prints only fixed strings and error codes, and sets `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 5` on create and rotate. If a workflow starts reading another table, add it to `GRANTED_TABLES` in `scripts/ops/create-ci-monitor-role.ts` and re-run with `--rotate`.

After applying, the tool connects as `ci_monitor` and checks the boundary instead of trusting the grants: the SELECT-able public relations are exactly the three granted tables (computed from `pg_class` oids), `ci_monitor` has no `CREATE` on schema `public` and belongs to no role, and an INSERT is refused. These checks exist because the boundary also depends on what PUBLIC and default ACLs grant. Measured on Neon (PG 18.6, 2026-11-07, read-only probe): PUBLIC has no `CREATE` on schema `public`, there are no public-schema functions, and both `pg_default_acl` rows grant only to `neon_superuser`; `TEMP` on the database comes via PUBLIC and is left in place (nothing is revoked from PUBLIC).

A rotate that fails after `ALTER ROLE ... PASSWORD` leaves the CI secret dead (the old password no longer works and the new URL file is removed on failure). Recovery: re-run with `--rotate`, then set the secret again.
