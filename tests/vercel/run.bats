#!/usr/bin/env bats
# Coverage for scripts/vercel-ignore-build.sh — the Vercel "Ignored Build Step".
#
# This script decides whether a deployment builds at all, and since 2026-08-08
# it can skip PRODUCTION, not just previews. A false skip silently withholds a
# code deploy, and — the lesson from PR #141, which shipped broken and was
# only caught by reading a real build log — a gate that fails open looks
# exactly like a gate that works. These tests pin the decision for every path.
#
# Exit code contract is Vercel's and inverted from the usual shell one:
#   exit 1 => BUILD, exit 0 => SKIP.
#
# Each test builds a throwaway git repo in a temp dir, so nothing touches the
# real repository or $HOME, and no network or GUI surface is involved.

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	SCRIPT="$REPO_ROOT/scripts/vercel-ignore-build.sh"

	TEST_TMP="$(mktemp -d)"
	REPO="$TEST_TMP/repo"

	# Isolate git completely: these tests clone and fetch, so they are the
	# first here to consult TRANSPORT config. A stray `url.*.insteadOf` in a
	# real ~/.gitconfig could rewrite `file://$REPO` out from under them, and a
	# test must never read the operator's $HOME regardless.
	REAL_GIT="$(command -v git)"
	export HOME="$TEST_TMP" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
	mkdir -p "$REPO"
	cd "$REPO" || exit 1

	git init --quiet -b main
	git config user.email "test@example.com"
	git config user.name "Test"
	git config commit.gpgsign false

	# A baseline commit so HEAD^ always resolves.
	mkdir -p app data docs .github/workflows
	echo "baseline" >app/page.tsx
	echo "[]" >data/facilities.json
	echo "# docs" >docs/README.md
	echo "name: ci" >.github/workflows/ci.yml
	git add -A
	git commit --quiet -m "baseline"
	BASE_SHA="$(git rev-parse HEAD)"

	# Vercel always sets these; individual tests override as needed.
	export VERCEL_ENV="preview"
	export VERCEL_GIT_COMMIT_REF="some-feature-branch"
	export VERCEL_GIT_PREVIOUS_SHA="$BASE_SHA"
}

teardown() {
	cd /
	rm -rf "$TEST_TMP"
}

commit_change() {
	local path="$1"
	mkdir -p "$(dirname "$path")"
	echo "changed $RANDOM" >"$path"
	git add -A
	git commit --quiet -m "change $path"
}

# BUILD is exit 1, SKIP is exit 0 — assert on the meaning, not the number.
assert_build() {
	[ "$status" -eq 1 ] || {
		echo "expected BUILD (exit 1), got exit $status; output: $output"
		return 1
	}
}

assert_skip() {
	[ "$status" -eq 0 ] || {
		echo "expected SKIP (exit 0), got exit $status; output: $output"
		return 1
	}
}

# --- the change this suite exists to protect -------------------------------

@test "production: data-only merge is SKIPPED (data reaches prod via db:sync, not the build)" {
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"
	commit_change "data/facilities.json"

	run bash "$SCRIPT"
	assert_skip
	[[ "$output" == *"production"* ]]
}

@test "production: a code change still BUILDS" {
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"
	commit_change "lib/data.ts"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"lib/data.ts"* ]]
}

@test "production: one code file among data files still BUILDS" {
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"
	echo "x" >data/facilities.json
	echo "y" >docs/README.md
	mkdir -p lib && echo "z" >lib/data.ts
	git add -A
	git commit --quiet -m "mixed"

	run bash "$SCRIPT"
	assert_build
}

@test "production: package.json (a release bump merged to main) BUILDS, refreshing the fallback snapshot" {
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"
	commit_change "package.json"

	run bash "$SCRIPT"
	assert_build
}

# --- preview behaviour (pre-existing, must not regress) --------------------

@test "preview: data-only diff is SKIPPED" {
	commit_change "data/facilities.json"

	run bash "$SCRIPT"
	assert_skip
}

@test "data/siting-context.json BUILDS — it is bundled into the app, not read from Neon" {
	# lib/siting-context.ts imports this file directly and every facility page
	# renders it. Unlike facilities.json (which is only withJsonFallback's
	# outage snapshot), skipping a commit that regenerates this ships stale
	# content with no Neon path to self-heal.
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"
	commit_change "data/siting-context.json"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"siting-context.json"* ]]
}

@test "an UNKNOWN file under data/ BUILDS — the allowlist names files, it does not glob the directory" {
	# The general property behind the test above: the next asset someone drops
	# into data/ must fail toward building, not be silently swallowed.
	commit_change "data/some-future-precompute.json"

	run bash "$SCRIPT"
	assert_build
}

@test "preview: docs-only diff is SKIPPED" {
	commit_change "docs/methodology.md"

	run bash "$SCRIPT"
	assert_skip
}

@test "preview: a code change BUILDS" {
	commit_change "app/page.tsx"

	run bash "$SCRIPT"
	assert_build
}

@test "preview: an unrecognized top-level path BUILDS (new source dirs are safe by default)" {
	commit_change "middleware.ts"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"middleware.ts"* ]]
}

@test ".github-only diff is SKIPPED — Actions config cannot change the built site" {
	commit_change ".github/workflows/ci.yml"

	run bash "$SCRIPT"
	assert_skip
}

@test "release-please branch is SKIPPED even though it touches package.json" {
	export VERCEL_GIT_COMMIT_REF="release-please--branches--main"
	commit_change "package.json"

	run bash "$SCRIPT"
	assert_skip
	[[ "$output" == *"release-please"* ]]
}

@test "dependabot-style package-lock change on a normal branch BUILDS" {
	commit_change "package-lock.json"

	run bash "$SCRIPT"
	assert_build
}

# --- fail-open paths: every uncertainty must BUILD -------------------------

@test "fails open (BUILD) when VERCEL_GIT_PREVIOUS_SHA names a commit not in the clone" {
	export VERCEL_GIT_PREVIOUS_SHA="0000000000000000000000000000000000000000"
	commit_change "data/facilities.json"

	run bash "$SCRIPT"
	# A SHA absent from the shallow clone must not crash the gate: it falls
	# back to HEAD^ and evaluates the diff normally (data-only => SKIP).
	assert_skip
	[[ "$output" == *"HEAD^"* ]]
}

@test "fails open (BUILD) when there is no base commit at all" {
	rm -rf "$REPO"
	mkdir -p "$REPO"
	cd "$REPO" || exit 1
	git init --quiet -b main
	git config user.email "test@example.com"
	git config user.name "Test"
	git config commit.gpgsign false
	mkdir -p data
	echo "only" >data/only.json
	git add -A
	git commit --quiet -m "root commit"
	unset VERCEL_GIT_PREVIOUS_SHA

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"fail-open"* ]]
}

@test "fails open (BUILD) on an empty diff" {
	export VERCEL_GIT_PREVIOUS_SHA="$(git rev-parse HEAD)"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"empty diff"* ]]
}

@test "fails open (BUILD) on a merge commit with no previous SHA" {
	git checkout --quiet -b side
	commit_change "data/side.json"
	git checkout --quiet main
	commit_change "data/main-side.json"
	git merge --quiet --no-ff side -m "merge side" >/dev/null 2>&1
	unset VERCEL_GIT_PREVIOUS_SHA

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"merge commit"* ]]
}

@test "a multi-commit push is evaluated across the WHOLE span, not just the last commit" {
	# The accumulation property: a code change followed by a data change must
	# still build, because the base is the last DEPLOYED commit.
	commit_change "lib/data.ts"
	commit_change "data/facilities.json"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"lib/data.ts"* ]]
}

# --- stale VERCEL_GIT_PREVIOUS_SHA: ancestry, not mere existence ------------
#
# `git cat-file -e` proves an object exists, not that it is on this branch's
# history. neon-sync.yml deletes its PR branch every wave (create-pull-request
# with delete-branch: true), so Vercel hands the script the PREVIOUS wave's
# commit — an orphan. Measured on deployment compute-atlas-92y4j4zw6, which
# built on `components/home/hero-plate-paths.ts`, a file in no commit of that
# PR. These tests pin all three outcomes of the ancestry check.

@test "a previous SHA orphaned by a DELETED branch is not trusted as a base" {
	# The production defect: the orphan resolves, but diffing against it spans
	# every unrelated change merged to main in between, so the gate always
	# finds code and never skips a data wave.
	git checkout --quiet -b automated/neon-sync-wave-1
	commit_change "data/facilities.json"
	local orphan_sha
	orphan_sha="$(git rev-parse HEAD)"

	git checkout --quiet main
	commit_change "components/home/hero-plate-paths.ts" # unrelated code, merged in between
	git branch -D automated/neon-sync-wave-1 >/dev/null  # ref gone; the object is not

	git checkout --quiet -b automated/neon-sync-wave-2
	commit_change "data/facilities.json"
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	run bash "$SCRIPT"
	assert_skip
	[[ "$output" == *"is not an ancestor of HEAD"* ]]
	[[ "$output" == *"using HEAD^ instead"* ]]
	# The whole point: the unrelated code file must not appear in the diff.
	[[ "$output" != *"hero-plate-paths"* ]]
}

@test "an ANCESTOR previous SHA is still trusted, spanning a multi-commit push" {
	# Behaviour on main must be unchanged, accumulation property included:
	# VERCEL_GIT_PREVIOUS_SHA is the baseline from setup(), a true ancestor.
	commit_change "lib/data.ts"
	commit_change "data/facilities.json"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"base=VERCEL_GIT_PREVIOUS_SHA"* ]]
	[[ "$output" == *"lib/data.ts"* ]]
}

@test "an ANCESTOR previous SHA still drives a data-only SKIP (not rerouted to HEAD^)" {
	commit_change "data/facilities.json"
	commit_change "docs/README.md"

	run bash "$SCRIPT"
	assert_skip
	[[ "$output" == *"base=VERCEL_GIT_PREVIOUS_SHA"* ]]
}

@test "a shallow clone that CAN be completed answers the ancestry question" {
	# Outcome (b) reached the hard way: the negative answer is only trusted
	# once history is complete, so --unshallow must run first.
	commit_change "lib/data.ts"
	commit_change "data/facilities.json"

	local clone="$TEST_TMP/shallow-ok"
	git clone --quiet --depth=2 "file://$REPO" "$clone"
	cd "$clone" || exit 1
	git config user.email "test@example.com"
	git config user.name "Test"
	[ "$(git rev-parse --is-shallow-repository)" = "true" ]

	# A commit object that EXISTS in the clone but is on no branch — what a
	# deleted-branch orphan looks like to `git cat-file -e`. Its tree is
	# HEAD^'s, so a script that trusted it would see a data-only diff.
	local orphan_sha
	orphan_sha="$(git commit-tree "$(git rev-parse "HEAD^^{tree}")" -m orphan </dev/null)"
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	run bash "$SCRIPT"
	assert_skip
	[[ "$output" == *"using HEAD^ instead"* ]]
	[[ "$output" == *"base=HEAD^"* ]]
	[ "$(git rev-parse --is-shallow-repository)" = "false" ]
}

@test "fails open (BUILD) when ancestry is undecidable and the clone stays shallow" {
	# Outcome (c), the load-bearing one. A shallow clone truncates history, so
	# "not an ancestor" may just mean the connecting commits were never
	# fetched; falling back to HEAD^ could then SKIP a code change sitting in
	# an earlier commit of the same push — a withheld production deploy.
	# Driven with a real shallow clone whose origin has been broken, so
	# `git fetch --unshallow` genuinely fails and the repo stays shallow.
	commit_change "lib/data.ts"
	commit_change "data/facilities.json"

	local clone="$TEST_TMP/shallow-stuck"
	git clone --quiet --depth=2 "file://$REPO" "$clone"
	cd "$clone" || exit 1
	git config user.email "test@example.com"
	git config user.name "Test"
	git remote set-url origin "$TEST_TMP/no-such-remote.git"
	[ "$(git rev-parse --is-shallow-repository)" = "true" ]

	# Same fabricated orphan: tree of HEAD^, so trusting it would read as a
	# data-only diff and SKIP. The guard must BUILD instead.
	local orphan_sha
	orphan_sha="$(git commit-tree "$(git rev-parse "HEAD^^{tree}")" -m orphan </dev/null)"
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"not provably complete"* ]]
	[[ "$output" == *"fail-open"* ]]
	[ "$(git rev-parse --is-shallow-repository)" = "true" ]
}

@test "fails open (BUILD) when the shallow probe itself ERRORS (no answer is not a negative)" {
	# Pins the positive-form probes. `git rev-parse --is-shallow-repository`
	# printing nothing must not read as "history is complete" — that inversion
	# is the only way the inconclusive arm becomes skip-capable.
	# Driven with a PATH shim that fails ONLY that subcommand; every other git
	# call passes through to the real binary, so nothing about the repository
	# or the decision is faked.
	local bin="$TEST_TMP/shim"
	mkdir -p "$bin"
	cat >"$bin/git" <<-EOF
		#!/usr/bin/env bash
		if [ "\$1" = "rev-parse" ] && [ "\$2" = "--is-shallow-repository" ]; then
		  exit 128
		fi
		exec "$REAL_GIT" "\$@"
	EOF
	chmod +x "$bin/git"

	# Same orphan topology as the deleted-branch test: without the guard this
	# resolves to HEAD^ and SKIPs on a data-only tip commit.
	git checkout --quiet -b wave-1
	commit_change "data/facilities.json"
	local orphan_sha
	orphan_sha="$(git rev-parse HEAD)"
	git checkout --quiet main
	commit_change "lib/data.ts"
	git branch -D wave-1 >/dev/null
	git checkout --quiet -b wave-2
	commit_change "data/facilities.json"
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	PATH="$bin:$PATH" run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"not provably complete"* ]]
	[[ "$output" == *"fail-open"* ]]
}

@test "production: a non-ancestor previous SHA BUILDS rather than narrowing to HEAD^" {
	# On main the previous SHA is an ancestor in normal operation, so reaching
	# this means main was rewritten — where HEAD^ can be narrower than the
	# push and a skip would withhold a production deploy.
	export VERCEL_ENV="production"
	export VERCEL_GIT_COMMIT_REF="main"

	git checkout --quiet -b rewritten
	commit_change "data/facilities.json"
	local orphan_sha
	orphan_sha="$(git rev-parse HEAD)"
	git checkout --quiet main
	commit_change "lib/data.ts"
	git branch -D rewritten >/dev/null
	commit_change "data/facilities.json"
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"this is not a preview"* ]]
	[[ "$output" == *"refusing to narrow"* ]]
	[[ "$output" == *"VERCEL_ENV=\"production\""* ]]
}

@test "fails open (BUILD) when the ancestry test itself ERRORS (rc >= 2 is not a negative)" {
	# The other half of the same rule: `git merge-base --is-ancestor` exits 0
	# for ancestor, 1 for a genuine negative and >=2 on error, so only rc 1
	# may be trusted as "not an ancestor". Latent today — the `cat-file -e`
	# gate rejects the usual bad input first — so it is driven with a PATH
	# shim that fails only that subcommand.
	local bin="$TEST_TMP/shim-anc"
	mkdir -p "$bin"
	cat >"$bin/git" <<-EOF
		#!/usr/bin/env bash
		if [ "\$1" = "merge-base" ] && [ "\$2" = "--is-ancestor" ]; then
		  exit 128
		fi
		exec "$REAL_GIT" "\$@"
	EOF
	chmod +x "$bin/git"

	# Data-only tip commit: an untrusted rc that fell through to either the
	# previous SHA or HEAD^ would SKIP here.
	commit_change "data/facilities.json"

	PATH="$bin:$PATH" run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"git exited 128"* ]]
	[[ "$output" == *"fail-open"* ]]
}

@test "an UNSET VERCEL_ENV does not get the preview narrowing — it BUILDS" {
	# The carve-out is written positively: only an explicit `preview` may
	# narrow to HEAD^. An absent or unrecognised VERCEL_ENV must not land on
	# the skip-capable arm, which is what `== "production"` would have done.
	unset VERCEL_ENV

	git checkout --quiet -b side-history
	commit_change "data/facilities.json"
	local orphan_sha
	orphan_sha="$(git rev-parse HEAD)"
	git checkout --quiet main
	commit_change "lib/data.ts"
	git branch -D side-history >/dev/null
	commit_change "data/facilities.json" # allowlist-only tip: HEAD^ would SKIP
	export VERCEL_GIT_PREVIOUS_SHA="$orphan_sha"

	run bash "$SCRIPT"
	assert_build
	[[ "$output" == *"this is not a preview"* ]]
	[[ "$output" == *"VERCEL_ENV=\"unset\""* ]]
	[[ "$output" == *"refusing to narrow"* ]]
}
