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
