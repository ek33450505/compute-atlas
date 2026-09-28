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
#      touches ONLY the Neon-generated data snapshot, docs, or GitHub config.
#      The site renders from Neon LIVE, so none of those change a byte a
#      visitor can see. Note "data" here means two NAMED files, not all of
#      data/ — see the allowlist comment below for why that distinction is
#      load-bearing.
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
#
#    ## VERCEL_GIT_PREVIOUS_SHA must be an ANCESTOR, not merely resolvable
#    (added 2026-09-28, from a real production log)
#
#    `git cat-file -e` proves an object EXISTS; it says nothing about whether
#    it is on this branch's history. `.github/workflows/neon-sync.yml` uses
#    peter-evans/create-pull-request with `delete-branch: true`, so every data
#    wave pushes a BRAND-NEW `automated/neon-sync` ref. Vercel then reports the
#    PREVIOUS wave's commit as VERCEL_GIT_PREVIOUS_SHA — an orphan of a branch
#    that no longer exists. It resolves fine, but it is not an ancestor of
#    HEAD, so the diff spans every unrelated change merged to main in between
#    and always finds code. Measured on deployment compute-atlas-92y4j4zw6:
#      [vercel-ignore] base=VERCEL_GIT_PREVIOUS_SHA (417de2e8...)
#      [vercel-ignore] BUILD — code change: components/home/hero-plate-paths.ts
#    ...a file that was in no commit of that PR. Cost: 22 wasted builds and
#    ~95K needless ISR writes per month.
#
#    So require ancestry, and treat only a POSITIVELY DETERMINED answer as an
#    answer. Outcomes:
#      a. ancestor            -> true base, use it (unchanged behaviour on
#                                main, including accumulation across skipped
#                                deployments).
#      b. NOT an ancestor,
#         history PROVABLY
#         complete            -> the negative is trustworthy. The previous SHA
#                                is off this history — a deleted branch, a
#                                rebase or a force-push all produce it — so
#                                fall through to HEAD^ (previews only, see
#                                the production carve-out below).
#      c. anything else       -> INCONCLUSIVE -> BUILD. Two ways to land here:
#                                a shallow clone truncates history, so "not an
#                                ancestor" may only mean the connecting
#                                commits were never fetched; and a git error
#                                (`--is-ancestor` exits >=2, the shallow probe
#                                fails) answers nothing at all. Falling back
#                                to HEAD^ on a multi-commit push whose code
#                                change sat in an earlier commit would
#                                SILENTLY SKIP it — a withheld deploy, the
#                                worst outcome this script has. Try once to
#                                complete the history, then BUILD.
#
#    Note the probes are written POSITIVELY (`== "false"`, `-eq 1`) so that an
#    empty or unexpected result falls into (c) and builds. The negative form
#    (`!= "true"`) would read a FAILED probe as "history is complete" and make
#    (c) unreachable — the exact inversion of the :37-40 invariant.
#
#    ## Residual exposure on previews (accepted, documented 2026-09-28)
#
#    Outcome (b) diffs HEAD^..HEAD, which is NARROWER than the push when the
#    previous SHA was orphaned by a rebase or force-push rather than by a
#    deleted branch: a >=2-commit push whose code change sat in an earlier
#    commit, with an allowlist-only tip commit, now skips where it used to
#    build. Off a preview that would be a withheld deploy, so ONLY an explicit
#    VERCEL_ENV=preview may narrow; everything else — production, or an
#    unset/unrecognised value — takes (c) and builds. On main the previous
#    SHA is an ancestor in normal operation, so that arm is reached only when
#    the history moved, which is exactly when building is right. What remains
#    is a PREVIEW that renders one commit behind its branch tip; the next push
#    rebuilds it, and merging to main builds through the ordinary ancestor
#    path.
range_base=""
how=""
non_ancestor_prev=""
anc_rc=0

if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]] &&
  git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null; then
  # rc 0 = ancestor, rc 1 = genuine non-ancestor, rc >=2 = git could not tell
  # (measured on git 2.55.0: a bad revision exits 128). Only rc 1 is a real
  # negative, so the rc is split rather than tested as a plain boolean.
  git merge-base --is-ancestor "$VERCEL_GIT_PREVIOUS_SHA" HEAD 2>/dev/null
  anc_rc=$?

  if [[ "$anc_rc" -eq 0 ]]; then
    # (a)
    range_base="$VERCEL_GIT_PREVIOUS_SHA"
    how="VERCEL_GIT_PREVIOUS_SHA"
  elif [[ "$anc_rc" -ne 1 ]]; then
    # (c) git errored — no answer at all.
    build "could not test whether previous SHA ${VERCEL_GIT_PREVIOUS_SHA} is an ancestor (git exited ${anc_rc}) (fail-open)"
  elif [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "false" ]]; then
    # (b) provably complete history, so the negative answer stands.
    non_ancestor_prev="$VERCEL_GIT_PREVIOUS_SHA"
  else
    # (c) shallow, or the probe itself failed. One attempt to complete the
    #     history, then re-test. The fetch is bounded by git's own low-speed
    #     abort — no external `timeout`, which is not guaranteed in the build
    #     image — because a DEGRADED origin (slow, not down) would otherwise
    #     hang the gate indefinitely.
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --unshallow >/dev/null 2>&1 || true
    git merge-base --is-ancestor "$VERCEL_GIT_PREVIOUS_SHA" HEAD 2>/dev/null
    anc_rc=$?
    if [[ "$anc_rc" -eq 0 ]]; then
      range_base="$VERCEL_GIT_PREVIOUS_SHA"
      how="VERCEL_GIT_PREVIOUS_SHA"
    elif [[ "$anc_rc" -eq 1 ]] &&
      [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" == "false" ]]; then
      non_ancestor_prev="$VERCEL_GIT_PREVIOUS_SHA"
    else
      build "cannot establish whether previous SHA ${VERCEL_GIT_PREVIOUS_SHA} is an ancestor — history is not provably complete (fail-open)"
    fi
  fi
fi

# The narrowing carve-out for outcome (b): see "Residual exposure" above.
#
# Written positively — only an explicit `preview` may narrow to HEAD^ — so an
# absent or unexpected VERCEL_ENV builds instead of skipping. The negative
# form (`== "production"`) would put every unrecognised value on the
# skip-capable arm, the same inversion as `!= "true"` above. The optimistic
# `${VERCEL_ENV:-preview}` in the final skip message is a LABEL on a decision
# already made, not a gate; the asymmetry is deliberate.
#
# The message says only what was established: non-ancestry, and that this is
# not a preview. WHICH cause produced the non-ancestry — a deleted branch, a
# rebase, a force-push — was never determined, so none is asserted.
if [[ -n "$non_ancestor_prev" && "${VERCEL_ENV:-}" != "preview" ]]; then
  build "previous SHA ${non_ancestor_prev} is not an ancestor of HEAD and this is not a preview (VERCEL_ENV=\"${VERCEL_ENV:-unset}\") — HEAD^ could be narrower than the push, so refusing to narrow (fail-open)"
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

# Logged here, not at the point of decision: the merge-commit and no-base
# checks above can still exit, and a notice naming a base that was never used
# would be a claim the script had not established. Same discipline applies to
# the CAUSE — non-ancestry is what was measured; which of the several possible
# causes produced it was not, so the causes are offered as examples only.
if [[ -n "$non_ancestor_prev" ]]; then
  log "previous SHA ${non_ancestor_prev} is not an ancestor of HEAD (a deleted branch, a rebase or a force-push all do this) — using ${how} instead"
fi
log "base=${how} (${range_base})"

changed="$(git diff --name-only "$range_base" HEAD 2>/dev/null)"
if [[ -z "$changed" ]]; then
  build "empty diff (fail-open)"
fi

# 3. Allowlist of skippable paths. Anything unrecognized triggers a build, so
#    new source directories are safe by default.
#
#    The two data files are named INDIVIDUALLY, not globbed as `data/*`. Not
#    everything under data/ is Neon-backed:
#      - facilities.json / facilities.meta.json ARE. The site reads Neon live;
#        the bundled copy is only `withJsonFallback`'s outage snapshot, so
#        letting it age until the next code deploy is the accepted tradeoff.
#      - data/siting-context.json is NOT. It is a static precompute from
#        `npm run build:mapdata`, imported directly into the bundle by
#        lib/siting-context.ts and rendered on every facility page. Skipping a
#        commit that regenerates it would ship stale siting context to users
#        with no Neon path to self-heal — so it must fall through to `build`.
#    Listing files instead of globbing keeps that distinction from silently
#    swallowing the next file someone drops into data/.
#
#    .github/* is here because CI/Actions config cannot influence the built
#    site — it is not read by `next build` and ships in no bundle.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    data/facilities.json | data/facilities.meta.json) continue ;;
    docs/* | .github/* | *.md | LICENSE | LICENSE-DATA) continue ;;
    *) build "code change: ${file}" ;;
  esac
done <<<"$changed"

skip "${VERCEL_ENV:-preview}: data/docs/config-only ($(printf '%s' "$changed" | grep -c .) file(s))"
