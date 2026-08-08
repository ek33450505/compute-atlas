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

# 2. Resolve a base ref to diff against. Vercel clones shallowly, so
#    origin/main is usually absent and has to be fetched.
base=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  base="origin/main"
elif git fetch --quiet --depth=50 origin main >/dev/null 2>&1 &&
  git rev-parse --verify --quiet FETCH_HEAD >/dev/null 2>&1; then
  base="FETCH_HEAD"
elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
  base="main"
fi

if [[ -z "$base" ]]; then
  build "no base ref to diff against (fail-open)"
fi

# Prefer the merge-base so the whole branch is considered, not just the tip
# commit — a branch whose LAST commit is data-only may still carry code.
range_base="$(git merge-base "$base" HEAD 2>/dev/null)"
if [[ -z "$range_base" ]]; then
  build "no merge-base with ${base} (fail-open)"
fi

changed="$(git diff --name-only "$range_base" HEAD 2>/dev/null)"
if [[ -z "$changed" ]]; then
  build "empty diff vs ${range_base} (fail-open)"
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
