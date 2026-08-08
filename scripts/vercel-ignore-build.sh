#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" — decides whether a deployment actually builds.
#
# Exit code contract (Vercel's, not ours):
#   exit 1  => PROCEED with the build
#   exit 0  => SKIP the build
#
# Policy:
#   1. ANY deployment — preview or production — is skipped when the diff
#      touches ONLY data, docs, or GitHub config. The site renders from Neon
#      LIVE, so none of those change a single byte a visitor can see.
#   2. Everything else builds.
#
# ## Why production is no longer unconditional (reversed 2026-08-08)
#
# It used to be, and the reason was sound at the time: data reached production
# THROUGH the build, so skipping a data-only merge would have withheld that
# data from the site.
#
# That is no longer how data ships. `npm run db:sync` writes Neon directly and
# busts the affected cache tags, so a data change is already live *before* the
# commit that records it is even merged — the commit is bookkeeping for the
# CC-BY snapshot, not a deploy.
#
# The one thing a production build still refreshes on a data-only merge is the
# `withJsonFallback` snapshot in `lib/data.ts`: `data/facilities.json` is
# bundled as the fallback used only when a Neon read FAILS. That snapshot now
# rides the next code deploy instead. Serving slightly older data during an
# outage is a far smaller cost than one production build per data commit, and
# it can be refreshed on demand at any time:
#     npx vercel redeploy --target production
#
# Fail-open by design: any uncertainty about the diff (no base ref, empty
# diff, git error) proceeds with the build. A wasted build is cheap; a
# silently skipped code deploy is not. That matters more now that this script
# can skip production — every uncertain path below must build.
#
# Wired via vercel.json -> "ignoreCommand".

# NOT `set -e`: failures are handled explicitly so we can fail open.
set -uo pipefail

log() { printf '[vercel-ignore] %s\n' "$*" >&2; }
build() { log "BUILD — $*"; exit 1; }
skip() { log "SKIP — $*"; exit 0; }

# 1. release-please's PR branch. By construction it only ever bumps a version
#     string — .release-please-manifest.json, CHANGELOG.md, and the `version`
#     field of package.json / package-lock.json — so its preview renders a site
#     byte-identical to the one already deployed. It cannot be handled by the
#     path allowlist below, because package.json / package-lock.json must
#     otherwise always build: that is exactly what makes dependabot's PRs build,
#     which is the behaviour we want. Merging still triggers a production build.
if [[ "${VERCEL_GIT_COMMIT_REF:-}" == release-please--* ]]; then
  skip "release-please version bump (production still builds on merge)"
fi

# 2. Resolve a base commit to diff against.
#
#    On production, VERCEL_GIT_PREVIOUS_SHA is the last commit actually
#    DEPLOYED to production — so it correctly accumulates across skipped
#    production deployments, exactly as it does for previews. A run of
#    data-only merges followed by a code merge diffs the whole span and
#    builds.
#
#    Vercel clones SINGLE-BRANCH and SHALLOW. `origin/main` does not exist in
#    the build container and `git fetch origin main` fails there, so the
#    original merge-base approach fell through to fail-open on EVERY run — it
#    was safe but never skipped anything. Confirmed in a real build log:
#      [vercel-ignore] BUILD — no base ref to diff against (fail-open)
#
#    What IS available: VERCEL_GIT_PREVIOUS_SHA (the commit of this branch's
#    previous deployment — the right base, and it spans a multi-commit push),
#    and HEAD^ once the shallow clone is deepened.
range_base=""
how=""

if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]] &&
  git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null; then
  range_base="$VERCEL_GIT_PREVIOUS_SHA"
  how="VERCEL_GIT_PREVIOUS_SHA"
fi

# A merge commit pulls in whatever the other branch carried, which a
# single-parent diff misrepresents. Always build — merges are rare.
if [[ -z "$range_base" ]] && git rev-parse --verify --quiet "HEAD^2" >/dev/null 2>&1; then
  build "merge commit — not summarisable by a single-parent diff"
fi

if [[ -z "$range_base" ]]; then
  # Deepen the shallow clone just enough to see the parent commit.
  if ! git rev-parse --verify --quiet "HEAD^" >/dev/null 2>&1; then
    git fetch --quiet --deepen=10 >/dev/null 2>&1 || true
  fi
  if git rev-parse --verify --quiet "HEAD^" >/dev/null 2>&1; then
    range_base="$(git rev-parse HEAD^)"
    how="HEAD^"
  fi
fi

if [[ -z "$range_base" ]]; then
  build "no base commit available (fail-open)"
fi
log "base=${how} (${range_base})"

changed="$(git diff --name-only "$range_base" HEAD 2>/dev/null)"
if [[ -z "$changed" ]]; then
  build "empty diff (fail-open)"
fi

# 3. Allowlist of skippable paths. Anything unrecognized triggers a build, so
#    new source directories are safe by default.
#
#    .github/* is here because CI/Actions config cannot influence the built
#    site — it is not read by `next build` and ships in no bundle.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    data/* | docs/* | .github/* | *.md | LICENSE | LICENSE-DATA) continue ;;
    *) build "code change: ${file}" ;;
  esac
done <<<"$changed"

skip "${VERCEL_ENV:-preview}: data/docs/config-only ($(printf '%s' "$changed" | grep -c .) file(s))"
