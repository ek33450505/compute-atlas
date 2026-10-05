#!/usr/bin/env bats
# Coverage for scripts/classify-drift-output.sh — the exit-code/output
# classifier that sits between `check-neon-drift.ts` and the nightly
# drift-alert.yml workflow.
#
# Why this exists: check-neon-drift.ts is written to ALWAYS exit 0, so a
# naive single grep on its output cannot tell "no drift" apart from "the
# detector never ran at all". That collapse made drift-alert.yml report
# "drift present" on 6 consecutive nightly runs (2026-09-03..2026-09-08)
# whose real cause was `--env-file=.env.local` — a flag absent on the
# runner — aborting node with exit 9 before the detector's own logic ever
# executed. Each fixture below is a real observed or contract-derived
# output; all five are already verified to classify correctly.

bats_require_minimum_version 1.5.0

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	SCRIPT="$REPO_ROOT/scripts/classify-drift-output.sh"
	SYNC_SCRIPT="$REPO_ROOT/scripts/classify-sync-convergence.sh"
	DIGEST_SCRIPT="$REPO_ROOT/scripts/classify-digest-output.sh"
	# Overridable only so the workflow-list tests can be mutation-tested against a
	# scratch copy; CI and every normal run use the real directory.
	WORKFLOWS_DIR="${WORKFLOWS_DIR:-$REPO_ROOT/.github/workflows}"
}

# Writes a JSON array fixture to $BATS_TEST_TMPDIR/<name> and echoes its path.
write_fixture() {
	local name="$1" content="$2"
	local path="$BATS_TEST_TMPDIR/$name"
	printf '%s' "$content" >"$path"
	echo "$path"
}

@test "converged: exit 0 with the detector's explicit no-drift message" {
	run bash -c "printf '%s\n' 'Neon: 1413 facilities, JSON: 1413 facilities' '✓ No drift detected between JSON and Neon' | '$SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "converged" ]
}

@test "real drift: exit 0 with a MISSING-facilities listing" {
	run bash -c "printf '%s\n' 'Neon: 1415 facilities, JSON: 1413 facilities' 'MISSING (in Neon, not JSON): 2' '   [\"a\",\"b\"]' | '$SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "drifted" ]
}

@test "detector-broken: node crash before the detector could run (the real 2026-09-08 failure)" {
	run bash -c "printf '%s\n' 'node: .env.local: not found' | '$SCRIPT' 9"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "detector-broken: Neon unreachable, reported via the non-blocking ::notice:: path" {
	run bash -c "printf '%s\n' '::notice::drift check errored (non-blocking): connect ETIMEDOUT' | '$SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "detector-broken: DATABASE_URL unset, detector skipped by design" {
	run bash -c "printf '%s\n' '::notice::DATABASE_URL not configured — skipping drift check' | '$SCRIPT' 0"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
}

@test "detector-broken: missing exit-code argument fails closed, never reads as converged" {
	# --separate-stderr: the script deliberately writes a diagnostic to stderr
	# for this case (fail-closed, not silent) — only stdout carries the
	# single-word classification contract.
	run --separate-stderr bash -c "printf '%s\n' 'No drift detected between JSON and Neon' | '$SCRIPT'"
	[ "$status" -eq 0 ]
	[ "$output" = "detector-broken" ]
	[[ "$stderr" == *"missing or non-numeric exit-code argument"* ]]
}

# Coverage for scripts/classify-sync-convergence.sh — the classifier that
# tells drift-alert.yml apart a sync mid-flight (converging) from one that
# has genuinely stalled (stuck) or isn't running at all (absent). Exists
# because on 2026-09-12 neon-sync.yml opened PR #295 at 23:41:09Z and
# drift-alert.yml ran at 23:44:38Z — 3.5 minutes later, well inside a human
# merge window — and filed issue #297 for a race, not a real problem.
# `converging` is the ONLY classification that suppresses the alert, so
# every validation failure below must be loud (non-zero exit, ::error:: on
# stderr) and must never resolve to `converging`.

@test "sync: any in-flight run classifies converging, even with no PR yet" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{"databaseId":1,"status":"in_progress"}]')"
	run "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "converging" ]
}

@test "sync: no runs and no open PR classifies absent" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "absent" ]
}

@test "sync: open PR one second younger than grace classifies converging (boundary: age = grace-1)" {
	created_epoch=1000
	created_at="$(jq -rn --arg e "$created_epoch" '$e | tonumber | todateiso8601')"
	prs="$(write_fixture prs.json "[{\"number\":295,\"createdAt\":\"$created_at\",\"url\":\"x\"}]")"
	runs="$(write_fixture runs.json '[]')"
	now=$((created_epoch + 59))
	run "$SYNC_SCRIPT" --now "$now" --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "converging" ]
}

@test "sync: open PR exactly grace seconds old classifies stuck (boundary: age = grace, inclusive)" {
	created_epoch=1000
	created_at="$(jq -rn --arg e "$created_epoch" '$e | tonumber | todateiso8601')"
	prs="$(write_fixture prs.json "[{\"number\":295,\"createdAt\":\"$created_at\",\"url\":\"x\"}]")"
	runs="$(write_fixture runs.json '[]')"
	now=$((created_epoch + 60))
	run "$SYNC_SCRIPT" --now "$now" --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "stuck" ]
}

@test "sync: open PR one second older than grace classifies stuck (boundary: age = grace+1)" {
	created_epoch=1000
	created_at="$(jq -rn --arg e "$created_epoch" '$e | tonumber | todateiso8601')"
	prs="$(write_fixture prs.json "[{\"number\":295,\"createdAt\":\"$created_at\",\"url\":\"x\"}]")"
	runs="$(write_fixture runs.json '[]')"
	now=$((created_epoch + 61))
	run "$SYNC_SCRIPT" --now "$now" --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "stuck" ]
}

@test "sync: the real 2026-09-12 timeline (PR opened, alert 3.5 min later) classifies converging" {
	prs="$(write_fixture prs.json '[{"number":295,"createdAt":"2026-09-12T23:41:09Z","url":"https://github.com/example/repo/pull/295"}]')"
	runs="$(write_fixture runs.json '[]')"
	alert_epoch="$(jq -rn '"2026-09-12T23:44:38Z" | fromdateiso8601')"
	run "$SYNC_SCRIPT" --now "$alert_epoch" --grace 900 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "converging" ]
}

@test "sync: missing --now fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--now"* ]]
}

@test "sync: missing --grace fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--grace"* ]]
}

@test "sync: empty --prs value fails loud, never converging" {
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--prs"* ]]
}

@test "sync: missing --runs fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--runs"* ]]
}

@test "sync: unknown flag fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs" --bogus x
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"unknown flag"* ]]
}

@test "sync: non-numeric --now fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now "not-a-number" --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--now"* ]]
}

@test "sync: zero --grace fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 0 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--grace"* ]]
}

@test "sync: --prs file that does not exist fails loud, never converging" {
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$BATS_TEST_TMPDIR/nope.json" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"does not exist"* ]]
}

@test "sync: empty --runs file fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$BATS_TEST_TMPDIR/empty_runs.json"
	: >"$runs"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"is empty"* ]]
}

@test "sync: invalid JSON in --prs fails loud, never converging" {
	prs="$(write_fixture prs.json 'not json')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"not valid JSON"* ]]
}

@test "sync: --runs that is a JSON object, not an array, fails loud, never converging" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '{}')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"not a JSON array"* ]]
}

@test "sync: unparseable createdAt fails loud, never converging" {
	prs="$(write_fixture prs.json '[{"number":295,"createdAt":"not-a-date","url":"x"}]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" != "converging" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"createdAt"* ]]
}

# Element-shape validation for --runs and --prs. The array-level checks above
# (exists/non-empty/valid-JSON/is-array) all pass on an array of garbage —
# `[{}]`, `[123]`, `["queued"]` are all valid JSON arrays. Rule 1 fires on
# "any element in --runs", so an unvalidated garbage element read as
# `converging`, the one classification that suppresses the alert, until this
# was closed (code-reviewer finding, 2026-09-13). Each case below asserts
# stdout is EMPTY, not just that status is non-zero — a script that printed
# `converging` and then exited 1 would pass a status-only assertion.

@test "sync: --runs element that is an empty object fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{}]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--runs"* ]]
}

@test "sync: --runs element that is a bare number fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[123]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--runs"* ]]
}

@test "sync: --runs element that is a bare string fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '["queued"]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"--runs"* ]]
}

@test "sync: --runs object missing databaseId fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{"status":"in_progress"}]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"databaseId"* ]]
}

@test "sync: --runs object missing status fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{"databaseId":1}]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"status"* ]]
}

@test "sync: --runs status that is not a string fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{"databaseId":1,"status":123}]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"status"* ]]
}

@test "sync: a well-formed --runs element still classifies converging (no regression)" {
	prs="$(write_fixture prs.json '[]')"
	runs="$(write_fixture runs.json '[{"databaseId":1,"status":"in_progress"}]')"
	run "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "converging" ]
}

@test "sync: --prs element missing createdAt fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[{"number":295,"url":"x"}]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"createdAt"* ]]
}

@test "sync: --prs element missing number fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[{"createdAt":"2026-09-12T23:41:09Z","url":"x"}]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"number"* ]]
}

@test "sync: --prs element missing url fails loud, stdout empty" {
	prs="$(write_fixture prs.json '[{"number":295,"createdAt":"2026-09-12T23:41:09Z"}]')"
	runs="$(write_fixture runs.json '[]')"
	run --separate-stderr "$SYNC_SCRIPT" --now 1000 --grace 60 --prs "$prs" --runs "$runs"
	[ "$status" -ne 0 ]
	[ "$output" = "" ]
	[[ "$stderr" == *"::error::"* ]]
	[[ "$stderr" == *"url"* ]]
}

# ---------------------------------------------------------------------------
# Coverage for scripts/classify-digest-output.sh — the classifier that sits
# between `check-digest-status.ts` and the discovery-watchdog workflow.
#
# Unlike classify-drift-output.sh, check-digest-status.ts does NOT always
# exit 0 — it exits 1 for BOTH a real crash (incomplete run found) and a
# detector failure (DB unreachable, query error). Exit code alone can't tell
# those apart, so this classifier checks the OUTPUT message first and the
# exit code only as a fallback. The ordering tests below pin that precedence.
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
# neon-sync.yml — the two artifact path lists vs build-map-data.mjs's outputs
#
# Why this exists: PR #329 (2026-09-16) opened red. `build:mapdata` gained two
# committed outputs in #324/#325 — components/home/hero-plate-paths.ts and
# public/data/pipeline-history.json — but neon-sync.yml's `add-paths` list was
# never extended, so the workflow REGENERATED both on the runner and then left
# them out of the commit. The hero plate has a currency test, so it went red;
# pipeline-history.json has none, so it would have gone stale in silence and
# stayed stale (the merge resolves the facilities.json drift, so the next run
# finds none and never rebuilds).
#
# The workflow already says these lists "MUST stay in sync" with the output
# list in the header of scripts/build-map-data.mjs. Nothing enforced it. This
# does, one-directionally: every committed output must appear in BOTH lists.
# The reverse is not asserted — add-paths legitimately also carries
# data/facilities.json and data/facilities.meta.json, which db:export writes.
#
# Every restore list is read from a NAMED step (step_checkout_list), never "the
# first checkout block in the file": neon-sync.yml's fallback step carries its
# own restore list ahead of the Discard step, and a file-wide first match read
# that one as the Discard list — a false failure on one test and a silent pass,
# against the wrong step, on its sibling. Each extractor also has an
# anti-vacuity test with a minimum line count, so a renamed step or a reformatted
# block fails loudly instead of yielding an empty list that covers nothing.
# ---------------------------------------------------------------------------

# Echoes the committed-output paths from build-map-data.mjs's header block, one
# per line. Entries sit at exactly three spaces after the `*`; wrapped
# description lines are indented far deeper and so are skipped. A bare `*` line
# ends the scan, but only AFTER an entry has been seen — one also sits between
# the trigger sentence and the first path, and exiting on it yields nothing.
mapdata_outputs() {
	awk '
		/outputs below are committed:/ { f = 1; next }
		f && /^ \*   [^ ]/ { n++; print $2; next }
		f && n > 0 && /^ \*$/ { exit }
	' "$REPO_ROOT/scripts/build-map-data.mjs"
}

# Echoes the paths listed under `add-paths: |` in workflow $1 (a file under
# $WORKFLOWS_DIR). Each workflow has exactly one create-pull-request step, so
# unlike the restore lists this needs no step anchor.
addpaths_list() {
	awk '
		/^          add-paths: \|$/ { f = 1; next }
		f && /^            [^ ]/ { print $1; next }
		f { exit }
	' "$WORKFLOWS_DIR/$1"
}

# Echoes the paths of the FIRST restore block inside the step named $2 of
# workflow $1, one per line. Scanning starts at that step's `- name:` line and
# stops at the next step, so a sibling step's own restore list is never read as
# this one's.
step_checkout_list() {
	awk -v step="      - name: $2" '
		$0 == step { s = 1; next }
		s && /^      - name:/ { exit }
		s && /^          git checkout -- \\$/ { f = 1; next }
		f && /^            [^ ]/ { print $1; next }
		f { exit }
	' "$WORKFLOWS_DIR/$1"
}

# Echoes, space-prefixed on one line, every path in list $1 that is absent from
# list $2 (both newline-separated). Empty output means $2 covers $1.
missing_paths() {
	local want="$1" have="$2" path missing=""
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		grep -qxF "$path" <<<"$have" || missing="$missing $path"
	done <<<"$want"
	printf '%s' "$missing"
}

NEON_FALLBACK_STEP="Fall back to build:mapdata --skip-nhd"
NEON_DISCARD_STEP="Discard generated map data on failure"
NHD_DISCARD_STEP="Discard generated artifacts on failure"
NHD_OVERLAY_STEP="Discard overlay artifacts before PR"

@test "each PR-creating workflow has exactly one add-paths key (addpaths_list reads only the first)" {
	# addpaths_list stops after the first block, so a second create-pull-request
	# step's add-paths would go unchecked. Count keys at any indent; comments that
	# mention `add-paths` have no colon after it and are not counted.
	local wf n
	for wf in neon-sync.yml nhd-backfill.yml; do
		n="$(grep -c '^[[:space:]]*add-paths:' "$WORKFLOWS_DIR/$wf")" || n=0
		[ "$n" -eq 1 ] || {
			echo "$wf has $n add-paths keys, expected exactly 1"
			return 1
		}
	done
}

@test "neon-sync: the Discard-step extractor finds that step, not the fallback's list (anti-vacuity)" {
	run step_checkout_list neon-sync.yml "$NEON_DISCARD_STEP"
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -ge 12 ]
	# The ledger is in the Discard step's list and NOT in the fallback step's
	# (which precedes it in the file), so its presence proves the scan landed on
	# the right step.
	grep -qxF "data/nhd-backfill-debt.json" <<<"$output"
	grep -qxF "data/siting-context.json" <<<"$output"
}

@test "neon-sync: the fallback-step extractor finds that step's restore list (anti-vacuity)" {
	run step_checkout_list neon-sync.yml "$NEON_FALLBACK_STEP"
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -ge 11 ]
	grep -qxF "data/siting-context.json" <<<"$output"
}

@test "neon-sync: add-paths commits every committed output of build:mapdata" {
	local outputs added missing
	outputs="$(mapdata_outputs)"
	added="$(addpaths_list neon-sync.yml)"
	[ -n "$outputs" ]
	[ -n "$added" ]
	missing="$(missing_paths "$outputs" "$added")"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but neon-sync.yml add-paths does not commit them:$missing"
		return 1
	}
}

@test "neon-sync: the failure-discard list reverts every committed output of build:mapdata" {
	local outputs discarded missing
	outputs="$(mapdata_outputs)"
	discarded="$(step_checkout_list neon-sync.yml "$NEON_DISCARD_STEP")"
	[ -n "$outputs" ]
	[ -n "$discarded" ]
	missing="$(missing_paths "$outputs" "$discarded")"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but the fail-closed discard step leaves them in the tree:$missing"
		return 1
	}
}

@test "neon-sync: add-paths and the discard list carry the same generated artifacts" {
	# The two lists may differ only by db:export's own outputs, which
	# build:mapdata never touches and which must therefore never be reverted.
	local added discarded extra=""
	added="$(addpaths_list neon-sync.yml)"
	discarded="$(step_checkout_list neon-sync.yml "$NEON_DISCARD_STEP")"
	[ -n "$added" ]
	[ -n "$discarded" ]
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		case "$path" in
			data/facilities.json|data/facilities.meta.json) continue ;;
		esac
		grep -qxF "$path" <<<"$discarded" || extra="$extra $path"
	done <<<"$added"
	[ -z "$extra" ] || {
		echo "committed by add-paths but never reverted on a failed build:mapdata:$extra"
		return 1
	}
}

@test "neon-sync: the fallback step restores every output of build:mapdata before re-running it" {
	# The fallback runs after a failed full build that may have left partial
	# output behind; it must start from committed state, not from that debris.
	local outputs restored missing
	outputs="$(mapdata_outputs)"
	restored="$(step_checkout_list neon-sync.yml "$NEON_FALLBACK_STEP")"
	[ -n "$outputs" ]
	[ -n "$restored" ]
	missing="$(missing_paths "$outputs" "$restored")"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but the fallback step does not restore them first:$missing"
		return 1
	}
}

# ---------------------------------------------------------------------------
# nhd-backfill.yml — what an unattended run may put in its auto-merged PR
#
# The PR is auto-merged, so its add-paths is the whole of what an unattended run
# can publish. It is pinned to the siting-context data plus its debt ledger: the
# overlay files come from untrusted upstreams (USGS, WRI, HIFLD, drought.gov)
# and are rebuilt by every neon-sync wave anyway, so none may ride this PR.
# ---------------------------------------------------------------------------

@test "nhd-backfill: add-paths is exactly siting-context + the debt ledger (no overlay rides the auto-merge)" {
	run addpaths_list nhd-backfill.yml
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -eq 2 ] || {
		echo "nhd-backfill.yml add-paths must carry exactly 2 paths, got ${#lines[@]}: $output"
		return 1
	}
	grep -qxF "data/siting-context.json" <<<"$output"
	grep -qxF "data/nhd-backfill-debt.json" <<<"$output"
}

@test "nhd-backfill: the failure-discard extractor finds that step's restore list (anti-vacuity)" {
	run step_checkout_list nhd-backfill.yml "$NHD_DISCARD_STEP"
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -ge 12 ]
	grep -qxF "data/nhd-backfill-debt.json" <<<"$output"
	grep -qxF "data/siting-context.json" <<<"$output"
}

@test "nhd-backfill: the failure-discard step reverts every path add-paths would commit" {
	local added discarded missing
	added="$(addpaths_list nhd-backfill.yml)"
	discarded="$(step_checkout_list nhd-backfill.yml "$NHD_DISCARD_STEP")"
	[ -n "$added" ]
	[ -n "$discarded" ]
	missing="$(missing_paths "$added" "$discarded")"
	[ -z "$missing" ] || {
		echo "committed by add-paths but never reverted when the backfill fails:$missing"
		return 1
	}
}

@test "nhd-backfill: the overlay-discard extractor finds that step's restore list (anti-vacuity)" {
	run step_checkout_list nhd-backfill.yml "$NHD_OVERLAY_STEP"
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -ge 10 ]
	grep -qxF "public/data/water.geojson" <<<"$output"
	# This step must revert ONLY the overlays. The failure-discard step, which
	# precedes it in the file, also lists the siting data and the ledger, so an
	# unanchored extractor would read that block and include them here.
	if grep -qxF "data/siting-context.json" <<<"$output" || grep -qxF "data/nhd-backfill-debt.json" <<<"$output"; then
		echo "the overlay-discard step must not revert the data the PR commits, but its list is: $output"
		return 1
	fi
}

@test "nhd-backfill: the overlay discard plus add-paths accounts for every output of build:mapdata" {
	# A regenerated overlay is either reverted before the PR or is itself an
	# add-path; any build:mapdata output in neither could slip into the PR.
	local outputs reverted added missing
	outputs="$(mapdata_outputs)"
	reverted="$(step_checkout_list nhd-backfill.yml "$NHD_OVERLAY_STEP")"
	added="$(addpaths_list nhd-backfill.yml)"
	[ -n "$outputs" ]
	[ -n "$reverted" ]
	[ -n "$added" ]
	missing="$(missing_paths "$outputs" "$reverted"$'\n'"$added")"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but nhd-backfill.yml neither reverts nor adds them:$missing"
		return 1
	}
}

# ---------------------------------------------------------------------------
# scripts/classify-sync-prs.sh — the "defer while a neon-sync PR is open" gate
# ---------------------------------------------------------------------------
# This logic used to be inline YAML shell in nhd-backfill.yml with no test, and
# produced three bugs in one evening: an empty-vs-'0' compare that made the gate
# a no-op, a `((n++))` that aborted under `set -e`, and a floored-hours compare
# that stretched "24h" to ~25h. It also used GNU-only `date -d`. The clock is
# fixed below so every boundary is exact: NOW = 2025-10-03T14:00:00Z.

SYNC_PRS_NOW=1759500000

# One element of the array the workflow builds from the pulls API.
pr_json() {
	printf '{"number":%s,"isCrossRepository":%s,"createdAt":"%s"}' "$1" "$2" "$3"
}

# Runs the classifier over a JSON fixture at the fixed clock.
classify_prs() {
	local path
	path="$(write_fixture "prs.json" "$1")"
	"$REPO_ROOT/scripts/classify-sync-prs.sh" "$SYNC_PRS_NOW" <"$path"
}

# A verdict is exactly one line: the workflow echoes it into a log, where a
# second line starting "::error::" would be read as a workflow command.
assert_one_line() {
	[ "${#lines[@]}" -eq 1 ]
}

# A rejection is exit 2, an EMPTY stdout (so nothing can be echoed as a verdict)
# and a message on stderr. Call after `run --separate-stderr`.
assert_rejected() {
	[ "$status" -eq 2 ]
	[ -z "$output" ]
	grep -q "classify-sync-prs:" <<<"$stderr"
}

@test "classify-sync-prs: the script is executable (the workflow runs it by path)" {
	[ -x "$REPO_ROOT/scripts/classify-sync-prs.sh" ]
}

@test "classify-sync-prs: no open PR -> proceed" {
	run classify_prs '[]'
	[ "$status" -eq 0 ]
	[ "$output" = "proceed" ]
	assert_one_line
}

@test "classify-sync-prs: one same-repo PR 1h old -> defer 1" {
	run classify_prs "[$(pr_json 41 false 2025-10-03T13:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 1" ]
	assert_one_line
}

@test "classify-sync-prs: 23h59m old is still fresh -> defer" {
	run classify_prs "[$(pr_json 41 false 2025-10-02T14:01:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 1" ]
	assert_one_line
}

@test "classify-sync-prs: exactly 24h old is still fresh (the limit is strictly greater)" {
	run classify_prs "[$(pr_json 41 false 2025-10-02T14:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 1" ]
	assert_one_line
}

@test "classify-sync-prs: 24h01m old -> stale (not stretched to ~25h by hour flooring)" {
	run classify_prs "[$(pr_json 41 false 2025-10-02T13:59:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #41 (24h)" ]
	assert_one_line
}

@test "classify-sync-prs: 30h old -> stale, naming the PR and its age" {
	run classify_prs "[$(pr_json 41 false 2025-10-02T08:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #41 (30h)" ]
	assert_one_line
}

@test "classify-sync-prs: two same-repo PRs, one stale -> stale names only the old one" {
	run classify_prs "[$(pr_json 41 false 2025-10-03T13:00:00Z),$(pr_json 42 false 2025-10-02T08:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #42 (30h)" ]
	assert_one_line
}

@test "classify-sync-prs: two stale PRs are both listed, comma-separated, on one line" {
	run classify_prs "[$(pr_json 41 false 2025-10-02T08:00:00Z),$(pr_json 42 false 2025-10-01T14:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #41 (30h), #42 (48h)" ]
	assert_one_line
}

@test "classify-sync-prs: two fresh same-repo PRs -> defer 2" {
	run classify_prs "[$(pr_json 41 false 2025-10-03T13:00:00Z),$(pr_json 42 false 2025-10-03T12:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 2" ]
	assert_one_line
}

@test "classify-sync-prs: a fork-only PR is ignored even when 30h old -> proceed" {
	run classify_prs "[$(pr_json 99 true 2025-10-02T08:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "proceed" ]
	assert_one_line
}

@test "classify-sync-prs: a fork PR is dropped before any other field is read, and nothing in it executes" {
	local marker="$BATS_TEST_TMPDIR/pwned"
	# Every other field of these forks is hostile or absent; only the boolean
	# isCrossRepository is read, so none of it can matter or run.
	run classify_prs "[$(pr_json 99 true "\$(touch $marker)"),$(pr_json 98 true "\`touch $marker\`"),$(pr_json '"x\n::error::y"' true junk),{\"isCrossRepository\":true}]"
	[ "$status" -eq 0 ]
	[ "$output" = "proceed" ]
	assert_one_line
	[ ! -e "$marker" ]
}

@test "classify-sync-prs: fork PR plus a fresh same-repo PR -> defer 1 (the fork does not count)" {
	run classify_prs "[$(pr_json 99 true 2025-10-02T08:00:00Z),$(pr_json 41 false 2025-10-03T13:00:00Z)]"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 1" ]
	assert_one_line
}

@test "classify-sync-prs: an entry with no isCrossRepository field -> exit 2 (provenance unknown, fail closed)" {
	run --separate-stderr classify_prs "[$(pr_json 41 false 2025-10-03T13:00:00Z),{\"number\":42,\"createdAt\":\"2025-10-03T13:00:00Z\"}]"
	assert_rejected
}

@test "classify-sync-prs: a non-boolean isCrossRepository -> exit 2 (the string 'true' would otherwise not be a fork)" {
	run --separate-stderr classify_prs "[$(pr_json 41 '"true"' 2025-10-02T08:00:00Z)]"
	assert_rejected
}

@test "classify-sync-prs: invalid JSON -> exit 2" {
	run --separate-stderr classify_prs 'not json'
	assert_rejected
}

@test "classify-sync-prs: JSON that is not an array -> exit 2" {
	run --separate-stderr classify_prs '{"number":41}'
	assert_rejected
}

@test "classify-sync-prs: empty stdin (e.g. the API call failed upstream) -> exit 2, never 'proceed'" {
	run --separate-stderr classify_prs ''
	assert_rejected
}

@test "classify-sync-prs: a same-repo PR with no createdAt -> exit 2 (fail closed)" {
	run --separate-stderr classify_prs '[{"number":41,"isCrossRepository":false}]'
	assert_rejected
}

@test "classify-sync-prs: a same-repo PR with an unparseable createdAt -> exit 2 (fail closed)" {
	run --separate-stderr classify_prs "[$(pr_json 41 false yesterday-ish)]"
	assert_rejected
}

@test "classify-sync-prs: a string number carrying a newline + ::error:: is rejected, never echoed" {
	# Unvalidated, this prints "stale #41" / "::error::pwn (30h)": a second line the
	# runner would execute as a workflow command.
	run --separate-stderr classify_prs "[$(pr_json '"41\n::error::pwn"' false 2025-10-02T08:00:00Z)]"
	assert_rejected
	! grep -qF "::error::pwn" <<<"$stderr"
}

@test "classify-sync-prs: a fractional or missing number -> exit 2" {
	run --separate-stderr classify_prs "[$(pr_json 4.5 false 2025-10-02T08:00:00Z)]"
	assert_rejected
	run --separate-stderr classify_prs '[{"isCrossRepository":false,"createdAt":"2025-10-02T08:00:00Z"}]'
	assert_rejected
}

@test "classify-sync-prs: a createdAt with a trailing newline + ::error:: is rejected, never echoed" {
	# jq 1.7's fromdateiso8601 accepts this string (it stops at the newline), so only
	# the explicit shape check keeps the text out of the verdict path.
	run --separate-stderr classify_prs "[$(pr_json 41 false '2025-10-02T08:00:00Z\n::error::x')]"
	assert_rejected
	! grep -qF "::error::x" <<<"$stderr"
}

@test "classify-sync-prs: a createdAt with only a trailing newline is rejected (the shape check must be end-anchored)" {
	run --separate-stderr classify_prs "[$(pr_json 41 false '2025-10-02T08:00:00Z\n')]"
	assert_rejected
}

@test "classify-sync-prs: a non-numeric now argument -> exit 2" {
	run --separate-stderr bash -c "echo '[]' | '$REPO_ROOT/scripts/classify-sync-prs.sh' tomorrow"
	assert_rejected
}

@test "classify-sync-prs: with no now argument it uses the real clock (a PR created just now defers)" {
	local created
	created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	run bash -c "echo '[$(pr_json 41 false "$created")]' | '$REPO_ROOT/scripts/classify-sync-prs.sh'"
	[ "$status" -eq 0 ]
	[ "$output" = "defer 1" ]
	assert_one_line
}

# EXPECTED TO FAIL until the reviewed draft of nhd-backfill.yml is installed:
# the committed workflow still carries the inline GNU-date / branch-name version.
@test "classify-sync-prs: nhd-backfill.yml's defer step pipes the owner-namespaced pulls query into the script" {
	local code
	# Comments and the step's error text also name the script and the old query, so
	# assert on non-comment lines only.
	code="$(grep -v '^[[:space:]]*#' "$WORKFLOWS_DIR/nhd-backfill.yml")"
	# A real invocation (the API output piped into it), not just a mention.
	grep -qE '\|[[:space:]]*(bash[[:space:]]+)?scripts/classify-sync-prs\.sh' <<<"$code"
	# Server-side, owner-namespaced head filter: a fork's same-named branch cannot match it.
	grep -qF 'head=${GITHUB_REPOSITORY_OWNER}:automated/neon-sync' <<<"$code"
	# The bare branch-name filter is the bypass: forks match it, and newest-first
	# paging lets 100 fork PRs push the real stale PR off the page -> "proceed".
	if grep -qF -- '--head automated/neon-sync' <<<"$code"; then
		echo "nhd-backfill.yml still queries by bare branch name (gh pr list --head automated/neon-sync)"
		return 1
	fi
	# Cross-repo is decided from the API's own head vs base repo, not an env var: an
	# absent or differently-cased GITHUB_REPOSITORY would drop EVERY real PR -> "proceed".
	grep -qF '.head.repo.full_name != .base.repo.full_name' <<<"$code"
	if grep -qF 'env.GITHUB_REPOSITORY' <<<"$code"; then
		echo "nhd-backfill.yml compares against env.GITHUB_REPOSITORY, which fails open when it is absent or cased differently"
		return 1
	fi
	if grep -qF "date -u -d" <<<"$code"; then
		echo "nhd-backfill.yml still contains GNU-only 'date -u -d' outside a comment"
		return 1
	fi
}

# ---------------------------------------------------------------------------
# The workflows' `gh api --jq` projections, exercised exactly as they run
# ---------------------------------------------------------------------------
# `gh api … --jq` turns the raw GET /repos/{repo}/pulls array into the shape the
# classifiers consume. The program is extracted from the workflow file itself (never
# copied here), so these fail if the workflow's compare is wrong, and they fail until
# the reviewed drafts are installed because the committed files carry no projection.
# (jq here, gojq inside `gh`; the programs use only field access, select and
# comparisons, which the two agree on.)

# The Nth `--jq '<program>'` on a non-comment line of workflows/$1.
workflow_jq_program() {
	grep -v '^[[:space:]]*#' "$WORKFLOWS_DIR/$1" | sed -n "s/^.*--jq '\(.*\)'.*\$/\1/p" | sed -n "${2}p"
}

# One element of the raw pulls API array, limited to the fields the projections read.
# Args: number created_at head_repo base_repo ("null" head_repo = a deleted fork).
pull_json() {
	local head=null
	[ "$3" = null ] || head="{\"full_name\":\"$3\"}"
	printf '{"number":%s,"created_at":"%s","html_url":"https://github.com/%s/pull/%s","head":{"repo":%s},"base":{"repo":{"full_name":"%s"}}}' \
		"$1" "$2" "$4" "$1" "$head" "$4"
}

# Raw pulls array -> nhd-backfill.yml's exact projection -> the classifier.
nhd_verdict() {
	local prog path
	prog="$(workflow_jq_program nhd-backfill.yml 1)"
	[ -n "$prog" ] || return 1
	path="$(write_fixture "pulls.json" "$1")"
	jq -c "$prog" "$path" | "$REPO_ROOT/scripts/classify-sync-prs.sh" "$SYNC_PRS_NOW"
}

# Raw pulls array -> drift-alert.yml's exact projection (its first query).
drift_prs() {
	local prog
	prog="$(workflow_jq_program drift-alert.yml 1)"
	[ -n "$prog" ] || return 1
	jq -c "$prog" "$(write_fixture "pulls.json" "$1")"
}

@test "nhd-backfill projection: a same-repo PR counts; fork and deleted-fork PRs are dropped" {
	run nhd_verdict "[$(pull_json 7 2025-10-02T08:00:00Z acme/tracker acme/tracker),$(pull_json 8 2025-10-02T08:00:00Z evil/tracker acme/tracker),$(pull_json 9 2025-10-02T08:00:00Z null acme/tracker)]"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #7 (30h)" ]
}

@test "nhd-backfill projection: only a fork and a deleted fork -> proceed" {
	run nhd_verdict "[$(pull_json 8 2025-10-02T08:00:00Z evil/tracker acme/tracker),$(pull_json 9 2025-10-02T08:00:00Z null acme/tracker)]"
	[ "$status" -eq 0 ]
	[ "$output" = "proceed" ]
}

@test "nhd-backfill projection: the verdict does not depend on GITHUB_REPOSITORY (unset, or differently cased)" {
	local pulls
	pulls="[$(pull_json 7 2025-10-02T08:00:00Z acme/tracker acme/tracker),$(pull_json 8 2025-10-02T08:00:00Z evil/tracker acme/tracker)]"
	unset GITHUB_REPOSITORY
	run nhd_verdict "$pulls"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #7 (30h)" ]
	export GITHUB_REPOSITORY=ACME/TRACKER
	run nhd_verdict "$pulls"
	[ "$status" -eq 0 ]
	[ "$output" = "stale #7 (30h)" ]
}

@test "drift-alert projection: emits the {number, createdAt, url} shape the convergence classifier reads, same-repo only" {
	run drift_prs "[$(pull_json 7 2025-10-03T13:55:00Z acme/tracker acme/tracker),$(pull_json 8 2025-10-03T13:56:00Z evil/tracker acme/tracker),$(pull_json 9 2025-10-03T13:57:00Z null acme/tracker)]"
	[ "$status" -eq 0 ]
	[ "$output" = '[{"number":7,"createdAt":"2025-10-03T13:55:00Z","url":"https://github.com/acme/tracker/pull/7"}]' ]
}

@test "drift-alert projection: a fork PR cannot read as a fresh sync and suppress the alert (real classifier -> absent)" {
	local prs runs
	prs="$BATS_TEST_TMPDIR/prs.json"
	runs="$(write_fixture "runs.json" '[]')"
	drift_prs "[$(pull_json 8 2025-10-03T13:56:00Z evil/tracker acme/tracker)]" >"$prs"
	run "$REPO_ROOT/scripts/classify-sync-convergence.sh" --now "$SYNC_PRS_NOW" --grace 900 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "absent" ]
}

@test "drift-alert projection: a real fresh PR -> converging, a real old PR -> stuck (real classifier)" {
	local prs runs
	prs="$BATS_TEST_TMPDIR/prs.json"
	runs="$(write_fixture "runs.json" '[]')"
	drift_prs "[$(pull_json 7 2025-10-03T13:55:00Z acme/tracker acme/tracker)]" >"$prs"
	run "$REPO_ROOT/scripts/classify-sync-convergence.sh" --now "$SYNC_PRS_NOW" --grace 900 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "converging" ]
	drift_prs "[$(pull_json 7 2025-10-02T08:00:00Z acme/tracker acme/tracker)]" >"$prs"
	run "$REPO_ROOT/scripts/classify-sync-convergence.sh" --now "$SYNC_PRS_NOW" --grace 900 --prs "$prs" --runs "$runs"
	[ "$status" -eq 0 ]
	[ "$output" = "stuck" ]
}

@test "drift-alert.yml: its two pulls queries carry the identical --jq projection" {
	local first second
	first="$(workflow_jq_program drift-alert.yml 1)"
	second="$(workflow_jq_program drift-alert.yml 2)"
	[ -n "$first" ]
	[ "$first" = "$second" ]
	[ -z "$(workflow_jq_program drift-alert.yml 3)" ]
}

@test "drift-alert.yml: both sync-PR queries are owner-namespaced and same-repo-filtered, none by bare branch name" {
	local code n
	# Comments name the old query too, so assert on non-comment lines only.
	code="$(grep -v '^[[:space:]]*#' "$WORKFLOWS_DIR/drift-alert.yml")"
	n="$(grep -cF 'head=${GITHUB_REPOSITORY_OWNER}:automated/neon-sync' <<<"$code")"
	[ "$n" -eq 2 ]
	n="$(grep -cF 'select(.head.repo.full_name == .base.repo.full_name)' <<<"$code")"
	[ "$n" -eq 2 ]
	# `gh pr list --head <name>` matches fork branches of the same name and returns
	# only 30 items by default: a fork PR could read as a fresh sync (suppressing the
	# alert) or bury a stuck one.
	if grep -qF -- '--head automated/neon-sync' <<<"$code"; then
		echo "drift-alert.yml still queries by bare branch name (gh pr list --head automated/neon-sync)"
		return 1
	fi
}
