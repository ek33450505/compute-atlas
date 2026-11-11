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
#      touches ONLY docs or GitHub config, which change no byte a visitor can
#      see. The one exception is docs/methodology.md: lib/methodology.ts reads
#      it at prerender time for the public /methodology page, so it builds.
#      No data/ file is allowlisted any more (the facility data snapshot is
#      untracked) — see the allowlist comment below.
#   2. Everything else builds.
#
# ## Why production is no longer unconditional (reversed 2026-08-08)
#
# It used to be, and the reason was sound at the time: data reached production
# THROUGH the build, so skipping a data-only merge would have withheld that
# data from the site.
#
# That is no longer how data ships. `npm run db:sync` writes Neon directly and
# busts the affected cache tags, so a data change is already live before any
# commit is merged. The facility, siting, ownership and NHD-debt data files are
# no longer tracked in git, so no data/ file is allowlisted: a diff that touches
# one is treated as a code change and BUILDS. Only docs and GitHub config skip.
# A production build can still be forced on demand:
#     npx vercel redeploy --target production
#
# Changed paths are listed with `--no-renames`, so a rename lists BOTH sides
# (e.g. `lib/x.ts -> docs/x.ts` shows `lib/x.ts` and builds) instead of only
# the destination. If a git ever rejected the flag, the command would exit non-zero
# with stderr suppressed, the diff would read empty, and the gate would fail OPEN
# (build).
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

# One attempt to complete a shallow history. Git's own low-speed abort
# (http.lowSpeedLimit/lowSpeedTime) ends a fetch that stays under 1000 B/s for
# 30 s, so a stalled origin cannot hang the gate. It does NOT bound a slow but
# steady fetch. No external `timeout` is used: it is not guaranteed in the
# build image.
unshallow() {
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch --quiet --unshallow >/dev/null 2>&1 || true
}

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
absent_prev=""
anc_rc=0

# A previous SHA missing from a shallow clone may merely be unfetched. Complete
# the history once before concluding anything, so the ancestry test below can
# run on it.
if [[ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ]] &&
  ! git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null; then
  log "previous SHA ${VERCEL_GIT_PREVIOUS_SHA} is not present in this clone — trying to complete the history"
  unshallow
fi

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
    #     history, then re-test (see unshallow() for what limits the fetch).
    unshallow
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

# The #364 preview log recorded only `base=HEAD^`, which cannot distinguish
# VERCEL_GIT_PREVIOUS_SHA being unset from it being set but absent from this
# clone (an orphan from a deleted branch, or simply unfetched) — the question
# V-6 rung 3 needs a real build log to answer. These two arms describe only
# the input, not the base the script goes on to choose: the merge-commit and
# no-base checks below can still build, so neither message names a base.
if [[ -z "${VERCEL_GIT_PREVIOUS_SHA:-}" ]]; then
  log "VERCEL_GIT_PREVIOUS_SHA is unset — no previous deployment to diff against"
elif ! git cat-file -e "${VERCEL_GIT_PREVIOUS_SHA}^{commit}" 2>/dev/null; then
  absent_prev="$VERCEL_GIT_PREVIOUS_SHA"
  log "previous SHA ${VERCEL_GIT_PREVIOUS_SHA} is not present in this clone (git cat-file -e failed) — ancestry cannot be tested"
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

# Same rule for a previous SHA that is absent even after the history was
# completed: HEAD^ may be narrower than the push, so only a preview may narrow.
if [[ -n "$absent_prev" && "${VERCEL_ENV:-}" != "preview" ]]; then
  build "previous SHA ${absent_prev} is absent from this clone and this is not a preview (VERCEL_ENV=\"${VERCEL_ENV:-unset}\") — HEAD^ could be narrower than the push, so refusing to narrow (fail-open)"
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

changed="$(git diff --name-only --no-renames "$range_base" HEAD 2>/dev/null)"
if [[ -z "$changed" ]]; then
  build "empty diff (fail-open)"
fi

# 3. Allowlist of skippable paths. Anything unrecognized triggers a build, so
#    new source directories are safe by default.
#
#    No data/ file is allowlisted: facility, siting, ownership and NHD-debt
#    data is no longer tracked in git (Neon is its only home), so a diff
#    touching data/ is a code change (fixtures, ledger tooling, retained
#    precomputes) and falls through to `build`. Naming files instead of
#    globbing `data/*` keeps the next file someone drops there from being
#    silently swallowed.
#
#    .github/* is here because CI/Actions config cannot influence the built
#    site — it is not read by `next build` and ships in no bundle.
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    docs/methodology.md) build "rendered by /methodology: ${file}" ;;
    docs/* | .github/* | *.md | LICENSE | LICENSE-DATA) continue ;;
    *) build "code change: ${file}" ;;
  esac
done <<<"$changed"

skip "${VERCEL_ENV:-preview}: data/docs/config-only ($(printf '%s' "$changed" | grep -c .) file(s))"
