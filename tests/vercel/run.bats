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
