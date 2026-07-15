# CLAUDE.md

Guidance for Claude Code (and human contributors) working in this repo.

**Compute Atlas** (`www.compute-atlas.com`) is a source-cited public tracker of AI
data centers, crypto-mining sites, and dedicated power-generation facilities in
the US. Next.js app + a curated, human-moderated dataset served from Postgres.

## Commands

```bash
npm run dev            # local dev server (next dev)
npm run build          # production build
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest run (unit/integration)
npm run test:watch     # vitest watch
npm run test:e2e       # playwright (a11y + e2e)
bats tests/discovery/run.bats   # shell tests for the discovery harness

# Database (Neon Postgres + Drizzle) — all read .env.local
npm run db:generate    # generate a migration from schema changes
npm run db:migrate     # apply migrations
npm run db:seed        # seed from data/facilities.json
npm run db:export      # export live facilities back to data/facilities.json

# Data operations
npm run submissions -- list pending          # review the staging queue
npm run submissions -- approve <id> "note"   # promote a pending submission to live
npm run submissions -- reject <id> "note"
npm run check-sources                        # source-liveness report (read-only)
```

There is **no CI yet** — the Vercel preview build on each PR is the only gate.
Run `npm run typecheck && npm test` locally before opening a PR.

## Architecture

- **Framework:** Next.js 16 (App Router, React Server Components) + React 19 + TypeScript.
- **Data:** Neon serverless Postgres via Drizzle ORM. Drizzle tables in
  `lib/db/schema.ts`; config in `drizzle.config.ts`. DB access is centralized in
  `lib/data.ts` — components don't query the DB directly.
- **Domain schema:** `lib/schema.ts` — the Zod `facilitySchema`, a discriminated
  union on `facilityType` (`data_center` | `crypto_mining` | `power_generation`).
  This is the single source of truth for a facility's shape; validate against it
  everywhere data enters the system.
- **Map:** MapLibre GL (`components/map/*`), globe projection + vector/satellite
  basemaps. `data/facilities.json` is the seed/export artifact, not the live source.
- **UI:** Tailwind v4, Base UI + shadcn primitives, a parchment/ink "atlas" design
  system in `app/globals.css :root`.
- **SEO:** `lib/seo.ts` builds JSON-LD (`Dataset` on the homepage, `Place` on
  facility pages); `app/sitemap.ts` + `app/robots.ts`.
- **Key routes:** `app/page.tsx` (home) · `app/map` · `app/table` · `app/explore/*`
  + lens pages (`states`/`operators`/`power`/`opposition`, incl. `[state]`/`[operator]`
  hubs) · `app/facilities/[slug]` · `app/contribute` · `app/admin/*` · `app/api/*`.

## Core invariant: writes are staged and human-gated

Nothing becomes a live facility automatically. Every change — whether from the
discovery pipeline or a public contributor — lands as a `pending` row in the
`submissions` table and requires an explicit human `approve` (`lib/submissions.ts`,
the `submissions` CLI, or the admin UI). Preserve this:

- **Public intake** (`POST /api/contribute`) is anonymous + moderated: it hard-pins
  `status=pending`, validates with Zod, and ignores privileged fields. Never relax it.
- **Admin/pipeline writes** (`POST /api/submissions`, approve/reject) require the
  `API_ADMIN_TOKEN` bearer. The admin pages use a lightweight single-secret cookie
  gate — there is intentionally **no user-account system** (durable product decision).
- **Data rigor:** every fact is traceable to a real, citable source. Do not
  fabricate coordinates, capacity, operators, or dates — omit unknown fields. See
  `CONTRIBUTING.md` and the data model in `lib/schema.ts`.

## Discovery pipeline

A local, scheduled, subscription-powered pipeline (`scripts/discovery/`) that
proposes new facilities and re-checks existing ones for status changes, staging
both as `pending`. It never writes live facilities. Full docs:
`docs/discovery-pipeline.md`. It uses the Claude Code subscription (not the metered
API) and runs via `launchd` on the maintainer's machine — treat it as an operator
tool, not part of the deployed app.

## Conventions

- React 19 functional components + hooks; test files alongside source
  (`Foo.tsx` → `Foo.test.tsx`), Vitest + Testing Library, assert on
  roles/text not test-ids. Playwright covers a11y/e2e.
- Accessibility is first-pass, not a later sweep (labels, focus-visible, keyboard
  nav, `prefers-reduced-motion`).
- Editorial voice: "source-cited" (not "source-verified"); the site reads
  impersonal, personal pages first-person. De-sell.
- **Dual license:** code MIT (`LICENSE`), data CC-BY-4.0 (`LICENSE-DATA`).

## Gotchas

- **`.env.local` quoting:** `vercel env add` keeps surrounding quotes; a quoted
  `DATABASE_URL` is invalid and fails *silently* (no fallback). Strip quotes.
- **Prod cache:** reads use tag-based `unstable_cache` with no timer. Data-only
  changes reach prod only via a prod-runtime write (approve on prod) or a redeploy —
  approving on a local runtime updates Neon but not prod's cache.
- **Local-only docs:** `docs/NEXT-SESSION.md` and `docs/track-c-candidate-ledger.md`
  are gitignored maintainer notes — never commit them.
- **Dev server:** don't run `next build`/`start` while `next dev` is live (it
  corrupts `.next`); a long-running dev server can also serve stale `globals.css`.
