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
