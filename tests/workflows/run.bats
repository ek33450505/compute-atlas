#!/usr/bin/env bats
# Coverage for scripts/classify-digest-output.sh — the classifier that sits
# between `check-digest-status.ts` and the discovery-watchdog workflow.
#
# (The drift-alert / neon-sync / nhd-backfill classifiers and workflow-shape
# tests that used to live here were removed with those workflows.)

bats_require_minimum_version 1.5.0

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	DIGEST_SCRIPT="$REPO_ROOT/scripts/classify-digest-output.sh"
}

# check-digest-status.ts does NOT always exit 0 — it exits 1 for BOTH a real
# crash (incomplete run found) and a detector failure (DB unreachable, query
# error). Exit code alone can't tell those apart, so this classifier checks the
# OUTPUT message first and the exit code only as a fallback. The ordering tests below pin that precedence.
# ---------------------------------------------------------------------------

@test "digest healthy: table does not exist, exit 0" {
	run bash -c "printf '%s\n' '✓ state_digest_runs table does not exist (feature not yet deployed to this DB).' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "healthy" ]
}

@test "digest healthy: table empty or all runs completed, exit 0" {
	run bash -c "printf '%s\n' '✓ state_digest_runs table is empty or all runs completed (no crashed runs detected).' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "healthy" ]
}

@test "digest healthy: empty stdin with exit 0 (detector printed nothing)" {
	run bash -c "printf '' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "healthy" ]
}

@test "digest crashed: single incomplete run, exit 1" {
	run bash -c "printf '%s\n' '::error::1 incomplete state digest run(s) found (completedAt IS NULL). run [abc] started 2026-09-01T00:00:00.000Z for window 2026-08-01T00:00:00.000Z .. 2026-09-01T00:00:00.000Z' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "crashed" ]
}

@test "digest crashed: multiple incomplete runs still match the same phrase" {
	run bash -c "printf '%s\n' '::error::3 incomplete state digest run(s) found (completedAt IS NULL). run [a]...; run [b]...; run [c]...' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "crashed" ]
}

@test "digest crashed: the crash message wins even if the exit-code arg is (incorrectly) 0" {
	# Proves rule 1 is message-driven, not exit-code-driven — the opposite
	# precedence of classify-drift-output.sh, which is exactly why this
	# classifier's rule order differs from its sibling (see header comment).
	run bash -c "printf '%s\n' '::error::1 incomplete state digest run(s) found (completedAt IS NULL).' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "crashed" ]
}

@test "digest crashed: rule 1 wins even when a detector-broken phrase is ALSO present" {
	# Adversarial: an output that could satisfy two rules must not be
	# ambiguous. The crash phrase must win because it is checked first.
	run bash -c "printf '%s\n' '::error::1 incomplete state digest run(s) found (completedAt IS NULL). Also: Failed to query state_digest_runs: connect ETIMEDOUT' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "crashed" ]
}

@test "digest detector-broken: DATABASE_URL unset, exit 1" {
	run bash -c "printf '%s\n' '::error::DATABASE_URL is not set. Configure it in .env.local (see .env.example) for a local run, or as a secret for the scheduled CI run. This check fails closed rather than skipping.' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: DATABASE_URL message wins even if exit-code arg is (incorrectly) 0" {
	# Same technique as the rule-1 test above: at exit 0, rule 4's non-zero
	# fallback cannot fire, so this can only pass via rule 2's own message
	# match — proving rule 2 is load-bearing, not just redundant with rule 4.
	run bash -c "printf '%s\n' '::error::DATABASE_URL is not set.' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: query failure message, exit 1" {
	run bash -c "printf '%s\n' '::error::Failed to query state_digest_runs: connect ETIMEDOUT' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: query failure message wins even if exit-code arg is (incorrectly) 0" {
	# Pins rule 3 independently of rule 4's fallback, same technique as above.
	run bash -c "printf '%s\n' '::error::Failed to query state_digest_runs: connect ETIMEDOUT' | '$DIGEST_SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: generic errored message, exit 1" {
	run bash -c "printf '%s\n' '::error::digest status check errored: unexpected token' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: missing exit-code argument" {
	# --separate-stderr: the script writes its diagnostic to stderr (fail-
	# closed, not silent) — only stdout carries the single-word contract.
	run --separate-stderr bash -c "printf '%s\n' 'anything' | '$DIGEST_SCRIPT'"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
	[[ "$stderr" == *"missing or non-numeric exit-code argument"* ]]
}

@test "digest detector-broken: non-numeric exit-code argument" {
	run --separate-stderr bash -c "printf '%s\n' 'anything' | '$DIGEST_SCRIPT' abc"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
	[[ "$stderr" == *"missing or non-numeric exit-code argument"* ]]
}

@test "digest detector-broken: empty stdin with non-zero exit and no message" {
	run bash -c "printf '' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: node stack trace exits non-zero with no recognized message" {
	run bash -c "printf '%s\n' 'TypeError: Cannot read properties of undefined (reading '\''startedAt'\'')' 'at fetchIncompleteRuns (/app/scripts/discovery/check-digest-status.ts:95:10)' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "digest detector-broken: a stack trace containing the bare word 'complete' does not match the crash phrase" {
	# Adversarial: the crash rule matches the literal phrase "incomplete state
	# digest run(s) found", not the bare substring "complete" — a coincidental
	# mention (e.g. a promise that "did not complete") must not misclassify
	# a real detector failure as a digest crash.
	run bash -c "printf '%s\n' '::error::digest status check errored: request did not complete before timeout' | '$DIGEST_SCRIPT' 1"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

# ---------------------------------------------------------------------------
# schema-check.yml shape. The daily schema guard must stay fail-closed: the
# secret is step-level only (npm ci runs install scripts) and nothing may mask
# a failure. Comments are stripped first so the header prose cannot satisfy
# or trip a check.
# ---------------------------------------------------------------------------

_schema_check_code() {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ] || return 99
	sed -e 's/[[:space:]]*#.*$//' "$REPO_ROOT/.github/workflows/schema-check.yml"
}

@test "schema-check.yml: permissions is contents: read only" {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ]
	run bash -c "$(declare -f _schema_check_code); REPO_ROOT='$REPO_ROOT'; _schema_check_code | awk '/^permissions:/{p=1;next} p&&/^[^ ]/{p=0} p&&NF{print}'"
	[ "$status" -eq 0 ]
	[ "$output" = "  contents: read" ]
}

@test "schema-check.yml: DATABASE_URL appears only under a step-level env" {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ]
	run bash -c "$(declare -f _schema_check_code); REPO_ROOT='$REPO_ROOT'; _schema_check_code | grep -n 'DATABASE_URL'"
	[ "$status" -eq 0 ]
	# exactly one occurrence, indented as a step env key (10 spaces), not a job env key (6)
	[ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
	[[ "$output" =~ ^[0-9]+:\ {10}DATABASE_URL: ]]
}

@test "schema-check.yml: no continue-on-error, no check:schema script, no --env-file" {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ]
	run bash -c "$(declare -f _schema_check_code); REPO_ROOT='$REPO_ROOT'; _schema_check_code | grep -E 'continue-on-error|check:schema|--env-file'"
	[ "$status" -eq 1 ]
}

@test "schema-check.yml: concurrency and timeout-minutes are set" {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ]
	run bash -c "$(declare -f _schema_check_code); REPO_ROOT='$REPO_ROOT'; _schema_check_code | grep -E '^concurrency:|^    timeout-minutes: [0-9]+'"
	[ "$status" -eq 0 ]
	[ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 2 ]
}

@test "schema-check.yml: the run line is exactly npx tsx scripts/check-schema-drift.ts" {
	[ -f "$REPO_ROOT/.github/workflows/schema-check.yml" ]
	run bash -c "$(declare -f _schema_check_code); REPO_ROOT='$REPO_ROOT'; _schema_check_code | grep -E 'check-schema-drift'"
	[ "$status" -eq 0 ]
	[ "$output" = "        run: npx tsx scripts/check-schema-drift.ts" ]
}
