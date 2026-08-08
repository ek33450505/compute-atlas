#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" — decides whether a deployment actually builds.
#
# Exit code contract (Vercel's, not ours):
#   exit 1  => PROCEED with the build
#   exit 0  => SKIP the build
#
# Policy:
#   1. Production ALWAYS builds. `lib/data.ts` imports `data/facilities.json`
#      as the Neon-outage fallback snapshot (`withJsonFallback`), so the
#      deployed bundle must keep a current copy even when a merge is data-only.
#   2. Preview builds are skipped when the diff touches ONLY data/docs. The
#      site renders from Neon, so a data-only preview is byte-for-byte the
#      same site as production — the JSON diff on the PR is the real review.
#
# Fail-open by design: any uncertainty about the diff (no base ref, empty
# diff, git error) proceeds with the build. A wasted build is cheap; a
# silently skipped code deploy is not.
#
# Wired via vercel.json -> "ignoreCommand".

# NOT `set -e`: failures are handled explicitly so we can fail open.
set -uo pipefail

log() { printf '[vercel-ignore] %s\n' "$*" >&2; }
build() { log "BUILD — $*"; exit 1; }
skip() { log "SKIP — $*"; exit 0; }

# 1. Production is never skipped.
if [[ "${VERCEL_ENV:-}" == "production" ]]; then
  build "production deployment"
fi

# 2. Resolve a base commit to diff against.
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

# 3. Allowlist of skippable paths. Anything unrecognized triggers a build,
#    so new source directories are safe by default.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    data/* | docs/* | *.md | LICENSE | LICENSE-DATA) continue ;;
    *) build "code change: ${file}" ;;
  esac
done <<<"$changed"

skip "data/docs-only preview ($(printf '%s' "$changed" | grep -c .) file(s))"
