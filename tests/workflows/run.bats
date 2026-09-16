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

# Echoes the paths listed under `add-paths: |` in neon-sync.yml.
addpaths_list() {
	awk '
		/^          add-paths: \|$/ { f = 1; next }
		f && /^            [^ ]/ { print $1; next }
		f { exit }
	' "$REPO_ROOT/.github/workflows/neon-sync.yml"
}

# Echoes the paths reverted by the `Discard generated map data on failure` step.
discard_list() {
	awk '
		/^          git checkout -- \\$/ { f = 1; next }
		f && /^            [^ ]/ { print $1; next }
		f { exit }
	' "$REPO_ROOT/.github/workflows/neon-sync.yml"
}

@test "neon-sync: the output extractor finds the real header block (anti-vacuity)" {
	# Without this, a header reformat that breaks the awk pattern would make the
	# two coverage tests below iterate over an EMPTY list and pass forever.
	run mapdata_outputs
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -ge 11 ]
	[[ "$output" == *"public/data/water.geojson"* ]]
	[[ "$output" == *"data/siting-context.json"* ]]
	[[ "$output" == *"components/home/hero-plate-paths.ts"* ]]
	[[ "$output" == *"public/data/pipeline-history.json"* ]]
	# A wrapped description line must never be mistaken for a path.
	[[ "$output" != *"build-hero-plate.mjs;"* ]]
}

@test "neon-sync: add-paths commits every committed output of build:mapdata" {
	local outputs added missing=""
	outputs="$(mapdata_outputs)"
	added="$(addpaths_list)"
	[ -n "$outputs" ]
	[ -n "$added" ]
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		grep -qxF "$path" <<<"$added" || missing="$missing $path"
	done <<<"$outputs"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but neon-sync.yml add-paths does not commit them:$missing"
		return 1
	}
}

@test "neon-sync: the failure-discard list reverts every committed output of build:mapdata" {
	local outputs discarded missing=""
	outputs="$(mapdata_outputs)"
	discarded="$(discard_list)"
	[ -n "$outputs" ]
	[ -n "$discarded" ]
	while IFS= read -r path; do
		[ -n "$path" ] || continue
		grep -qxF "$path" <<<"$discarded" || missing="$missing $path"
	done <<<"$outputs"
	[ -z "$missing" ] || {
		echo "build:mapdata writes these, but the fail-closed discard step leaves them in the tree:$missing"
		return 1
	}
}

@test "neon-sync: add-paths and the discard list carry the same generated artifacts" {
	# The two lists may differ only by db:export's own outputs, which
	# build:mapdata never touches and which must therefore never be reverted.
	local added discarded extra=""
	added="$(addpaths_list)"
	discarded="$(discard_list)"
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
