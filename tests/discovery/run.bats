#!/usr/bin/env bats
# Coverage for scripts/discovery/run.sh orchestration (control flow only —
# existing-facilities.ts / check-sources.ts / submit-candidates.ts are unit
# tested separately in Vitest). Every test isolates HOME, shims `claude` and
# `npx` so ZERO real network calls or claude invocations ever happen, and
# points LOG_DIR at a temp dir so the real discovery-logs/ is never touched.

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	RUN_SH="$REPO_ROOT/scripts/discovery/run.sh"

	# Portable timeout resolution (macOS lacks GNU `timeout` unless a
	# coreutils-providing formula is installed) + the shared "tsx -e"
	# import-safety script, both used only by the Task 7 "verification-gate
	# import safety" tests near the bottom of this file — mirrors run.sh's
	# own TIMEOUT_BIN resolution (run.sh:103-107) and candidates_file_has_array()
	# inline script (run.sh:133-144) exactly.
	TIMEOUT_BIN=""
	if command -v timeout >/dev/null 2>&1; then
		TIMEOUT_BIN="timeout"
	elif command -v gtimeout >/dev/null 2>&1; then
		TIMEOUT_BIN="gtimeout"
	fi
	IMPORT_CHECK_SCRIPT='
import { parseCandidatesJson } from "./scripts/discovery/submit-candidates.ts";
import { readFileSync } from "node:fs";
try {
  const a = parseCandidatesJson(readFileSync(process.argv[1], "utf8"));
  process.exit(Array.isArray(a) ? 0 : 1);
} catch {
  process.exit(1);
}
'

	TEST_TMP="$(mktemp -d)"
	HOME="$TEST_TMP/home"
	mkdir -p "$HOME"

	LOG_DIR="$TEST_TMP/discovery-logs"
	mkdir -p "$LOG_DIR"

	BIN_DIR="$TEST_TMP/bin"
	mkdir -p "$BIN_DIR"

	# --- fake `claude` binary: must NEVER be invoked in dry-run/disabled paths,
	# and must never touch the network even if invoked. -----------------------
	CLAUDE_CALL_LOG="$TEST_TMP/claude-calls.log"
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	# --- fake `npx`: intercepts the tsx helper invocations run.sh shells out
	# to, so run.sh's own control flow is exercised without the real network
	# calls the helpers would otherwise make (existing-facilities.ts hits the
	# DB, check-sources.ts issues ~1000+ live HTTP requests). ------------------
	NPX_CALL_LOG="$TEST_TMP/npx-calls.log"
	REAL_NPX="$(command -v npx)"
	cat >"$BIN_DIR/npx" <<EOF
#!/usr/bin/env bash
echo "npx \$*" >>"$NPX_CALL_LOG"
case "\$*" in
*"tsx -e"*)
	# The retry gate's candidates_file_has_array() validation call — MUST be
	# checked before the *submit-candidates.ts* case below, because this
	# call's inline script imports from "./scripts/discovery/submit-candidates.ts",
	# which would otherwise match that case first. Delegate to the REAL
	# npx/tsx so parseCandidatesJson's actual accept/reject logic runs (pure
	# import + local file read, zero network, safe to run for real). Every
	# other npx call below stays stubbed.
	exec "$REAL_NPX" "\$@"
	;;
*existing-facilities.ts*)
	echo "" # empty projection, matches run.sh's fail-open shape
	exit 0
	;;
*submit-candidates.ts*)
	exit 0
	;;
*check-sources.ts*)
	# Simulate the shimmed failure/empty-input case; run.sh appends "|| true"
	# to this call so a nonzero exit here must NOT fail the overall run.
	exit 1
	;;
*)
	exit 0
	;;
esac
EOF
	chmod +x "$BIN_DIR/npx"

	# --- fake notification surfaces (HARD RULE: tests must produce ZERO real
	# GUI side effects). run.sh's notify() prefers terminal-notifier and falls
	# back to osascript; BOTH are shimmed so neither can fire a real banner on
	# the maintainer's desktop, and the call log lets the alerting tests assert
	# that notify() actually fired. DISCOVERY_NOTIFY is deliberately left at its
	# default (true) so the tests exercise the REAL default path rather than a
	# disabled one.
	# `caffeinate` is a real macOS binary run.sh prefixes onto every claude
	# invocation. Shimmed to a pass-through so the suite has zero effect on the
	# host's power-assertion state — drop caffeinate's own flags, exec the rest.
	cat >"$BIN_DIR/caffeinate" <<'EOF'
#!/usr/bin/env bash
while [[ "${1:-}" == -* ]]; do shift; done
exec "$@"
EOF
	chmod +x "$BIN_DIR/caffeinate"

	NOTIFY_CALL_LOG="$TEST_TMP/notify-calls.log"
	for _surface in terminal-notifier osascript; do
		cat >"$BIN_DIR/$_surface" <<EOF
#!/usr/bin/env bash
echo "$_surface \$*" >>"$NOTIFY_CALL_LOG"
exit 0
EOF
		chmod +x "$BIN_DIR/$_surface"
	done

	export HOME LOG_DIR CLAUDE_CALL_LOG NPX_CALL_LOG NOTIFY_CALL_LOG
	export PATH="$BIN_DIR:$PATH"
	export DISCOVERY_LOG_DIR="$LOG_DIR"

	# Pin the rotation. run.sh's DEFAULT rotation was rebalanced 2026-08-14
	# (22 states, gap-states first); every rotation/cursor assertion in this
	# file was written against the prior 15-state list, and they are testing
	# CURSOR MECHANICS, not which states are in the list. Pinning the old list
	# here keeps those assertions exact and makes them immune to the next
	# rebalance. The default list's CONTENT is asserted separately, in the
	# dedicated test near the bottom that unsets this.
	export DISCOVERY_STATES="TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA"

	# run.sh now defaults STATES_PER_RUN=2 (Unit 2, 2026-08-14). Every existing
	# test in this file was written against the prior single-state-per-run
	# behavior, so pin STATES_PER_RUN=1 here to preserve exactly what they
	# assert (one claude call, one cursor advance, etc.) without weakening any
	# assertion. The dedicated multi-state tests below override this per-test.
	export STATES_PER_RUN=1
}

teardown() {
	rm -rf "$TEST_TMP"
}

@test "DISCOVERY_ENABLED unset exits 0 immediately with no claude/helper calls" {
	unset DISCOVERY_ENABLED || true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
	[ ! -s "$NPX_CALL_LOG" ]
}

@test "DISCOVERY_ENABLED=false exits 0 immediately with no claude/helper calls" {
	export DISCOVERY_ENABLED=false
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
	[ ! -s "$NPX_CALL_LOG" ]
}

@test "discovery-logs/DISABLED file present short-circuits even when enabled" {
	export DISCOVERY_ENABLED=true
	touch "$LOG_DIR/DISABLED"
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
	[ ! -s "$NPX_CALL_LOG" ]
}

@test "dry-run with enabled=true skips the real claude call" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	# dry-run must never shell out to the real claude binary
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

@test "dry-run with enabled=true skips the existing-facilities.ts fetch" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	run grep -c "existing-facilities.ts" "$NPX_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]
}

@test "cursor advances exactly once per run" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	echo "TX" >"$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	# STATES=(TX VA OH ...) — starting at TX, exactly one advance -> VA
	cursor_after="$(cat "$LOG_DIR/cursor.txt" | tr -d ' \n')"
	[ "$cursor_after" = "VA" ]

	# run again: exactly one further advance -> OH (guards against double
	# advance/skip across repeated invocations)
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	cursor_after_2="$(cat "$LOG_DIR/cursor.txt" | tr -d ' \n')"
	[ "$cursor_after_2" = "OH" ]
}

@test "check-sources failure after submit does not fail the overall run" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	# both submit-candidates.ts and check-sources.ts must have been invoked,
	# with check-sources coming after submit in the call log (fail-open
	# ordering: check-sources' shimmed nonzero exit must not propagate).
	run grep -n "submit-candidates.ts\|check-sources.ts" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
	submit_line="$(grep -n "submit-candidates.ts" "$NPX_CALL_LOG" | head -1 | cut -d: -f1)"
	check_line="$(grep -n "check-sources.ts" "$NPX_CALL_LOG" | head -1 | cut -d: -f1)"
	[ -n "$submit_line" ]
	[ -n "$check_line" ]
	[ "$check_line" -gt "$submit_line" ]
}

@test "check-sources failure emits a visible WARN and still completes the run" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"WARN: source-liveness check failed"* ]]
	[[ "$output" == *"discovery run"*"complete"* ]]
}

@test "live path invokes claude with the batch-contract system prompt" {
	export DISCOVERY_ENABLED=true
	# NOT dry-run: exercise the real claude-invocation branch (claude is shimmed,
	# so no network/subscription call happens). Guards against a regression that
	# drops --append-system-prompt and lets the inherited persona emit prose.
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ -s "$CLAUDE_CALL_LOG" ]
	grep -q -- "--append-system-prompt" "$CLAUDE_CALL_LOG"
}

@test "retry recovers when first claude call emits prose with no JSON array" {
	export DISCOVERY_ENABLED=true
	# Reproduces the 2026-07-15 AZ failure mode: first call emits a prose
	# session-summary with no array at all, second call emits a valid array.
	CLAUDE_COUNTER_FILE="$TEST_TMP/claude-call-count"
	echo 0 >"$CLAUDE_COUNTER_FILE"
	cat >"$BIN_DIR/claude" <<EOF
#!/usr/bin/env bash
echo "claude \$*" >> "$CLAUDE_CALL_LOG"
n="\$(cat "$CLAUDE_COUNTER_FILE")"
n=\$((n + 1))
echo "\$n" >"$CLAUDE_COUNTER_FILE"
if [ "\$n" -eq 1 ]; then
	echo "Session summary: I have reviewed the sources and logged a journal entry."
else
	echo '[{"name":"Recovered Facility","facilityType":"data_center"}]'
fi
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	call_count="$(cat "$CLAUDE_COUNTER_FILE")"
	[ "$call_count" -eq 2 ]
	[[ "$output" == *"WARN: claude output for"*"had no parseable JSON array — retrying once"* ]]

	outfile="$(find "$LOG_DIR" -name 'candidates-*.json' -print -quit)"
	[ -n "$outfile" ]
	grep -q "Recovered Facility" "$outfile"
}

@test "valid array on first claude call does not trigger a retry" {
	export DISCOVERY_ENABLED=true
	CLAUDE_COUNTER_FILE="$TEST_TMP/claude-call-count"
	echo 0 >"$CLAUDE_COUNTER_FILE"
	cat >"$BIN_DIR/claude" <<EOF
#!/usr/bin/env bash
echo "claude \$*" >> "$CLAUDE_CALL_LOG"
n="\$(cat "$CLAUDE_COUNTER_FILE")"
n=\$((n + 1))
echo "\$n" >"$CLAUDE_COUNTER_FILE"
echo '[{"name":"First Try Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	call_count="$(cat "$CLAUDE_COUNTER_FILE")"
	[ "$call_count" -eq 1 ]
	[[ "$output" != *"retrying once"* ]]
}

@test "dry-run never retries even though it writes an empty array" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	# dry-run must never invoke the real claude binary at all, retry or not
	[ ! -s "$CLAUDE_CALL_LOG" ]
	[[ "$output" != *"retrying once"* ]]
}

# --- session-limit hardening (2026-07-29 AZ crash) --------------------------

@test "claude nonzero exit does not kill the run — reaches completion" {
	export DISCOVERY_ENABLED=true
	# Reproduces the 2026-07-29 AZ crash: claude -p exits nonzero on
	# "You've hit your session limit" instead of a JSON array.
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo "You've hit your session limit"
exit 1
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	# Exit status is now 1 (alerting, 2026-08-14) — a run that staged nothing
	# must not look identical to a successful one from outside. The point of
	# this test is unchanged and asserted below: the run still REACHES
	# completion rather than aborting at the failure.
	[ "$status" -eq 1 ]
	[[ "$output" == *"discovery run"*"complete"* ]]
	[[ "$output" == *"skipping submit"* ]]
	# check-sources still ran after the failure — nothing was short-circuited
	run grep -q "check-sources.ts" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
}

@test "no-array result skips the submit step" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo "You've hit your session limit"
exit 1
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 1 ]

	# The retry gate's candidates_file_has_array() call is a `tsx -e` inline
	# script that itself imports from submit-candidates.ts, so a bare
	# "submit-candidates.ts" grep would false-positive on it — match on the
	# actual submit invocation's --run-id flag instead.
	run grep -c -- "submit-candidates.ts .*--run-id" "$NPX_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]

	run grep -q "check-sources.ts" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
}

@test "live run writes a heartbeat with claudeStatus ok on a valid array" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"X","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	[ -f "$LOG_DIR/heartbeat.json" ]
	grep -q '"claudeStatus": "ok"' "$LOG_DIR/heartbeat.json"
	grep -q '"lastRunAt"' "$LOG_DIR/heartbeat.json"
}

@test "session-limit run writes heartbeat with claudeStatus no_array" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo "You've hit your session limit"
exit 1
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 1 ]

	[ -f "$LOG_DIR/heartbeat.json" ]
	grep -q '"claudeStatus": "no_array"' "$LOG_DIR/heartbeat.json"
	# the heartbeat must ALSO carry a top-level verdict, so a reader does not
	# have to scan per-state entries to know the run was bad
	grep -q '"status": "degraded"' "$LOG_DIR/heartbeat.json"
}

@test "dry-run does not write a heartbeat" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -f "$LOG_DIR/heartbeat.json" ]
}

# --- self-reverting review cap (Phase 2 Unit B) ------------------------------
# BURST_START_DATE is a script constant (2026-07-30, 20-day burst window), not
# injectable from the test — so exact --max=25 assertions are clock-fragile
# once the real calendar passes 2026-08-19. The two tests below are the
# durable coverage: the env-override always wins regardless of clock, and the
# cap-computation block always emits a sane, parseable --max value.

@test "MAX_CANDIDATES env overrides the computed cap" {
	export DISCOVERY_ENABLED=true
	export MAX_CANDIDATES=3
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Cap Override Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	npx_output="$output"
	run grep -c -- "submit-candidates.ts .*--max=3" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
	[ "${output//[[:space:]]/}" != "0" ]
	[[ "$npx_output" == *"review cap for"* ]]
}

@test "review cap log line is emitted with a sane computed --max when no override is set" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Cap Compute Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	# the compute_cap block ran and logged its decision
	[[ "$output" == *"review cap for"* ]]

	# the submit call's --max is one of the two sane values (25 during the
	# burst window, 15 after) — never empty, never something else
	run grep -Eo -- "submit-candidates.ts .*--max=(25|15)" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
	[ -n "$output" ]
}

@test "caffeinate-absent regression: live run completes without an unbound-variable error" {
	# CAFFEINATE_PREFIX is an empty array whenever `caffeinate` is not on PATH
	# (true on this Linux/CI shim PATH by default). Under `set -u`, expanding
	# an empty array without the bash-3.2-safe idiom trips "unbound variable"
	# and the run would exit nonzero here with that message on stderr.
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Caffeinate Safety Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" != *"unbound variable"* ]]
	[[ "$output" == *"discovery run"*"complete"* ]]
}

# --- verification-gate import safety (Track 1 Task 7) -----------------------
# submit-candidates.ts now imports verify-source.ts / fetch-page-text.ts /
# ollama-client.ts at module scope (Task 6). The ONE place a BATS run
# genuinely executes that module scope for REAL — not the shimmed `npx`
# no-op at the `*submit-candidates.ts*` case in setup() above — is
# candidates_file_has_array()'s "tsx -e" inline import (run.sh:133-144);
# this file's npx shim deliberately delegates any "tsx -e" invocation to the
# real npx/tsx (see the comment at the top of that case). The gate's real
# verifyImpl is constructed only inside submit-candidates.ts's main() (see
# its buildRealVerifyImpl doc-comment), and main() never runs in a "-e"
# context because process.argv[1] there is not submit-candidates.ts's own
# path — but that is a structural guarantee internal to the module, not
# something visible from outside it, so it is pinned here as an explicit
# regression rather than left implicit. VERIFY_SOURCES_ENABLED is
# deliberately left UNSET in both tests below — the default (gate ON) config
# is exactly the scenario that matters: safety here must not depend on the
# opt-out being set.

@test "importing submit-candidates.ts via tsx -e attempts no connection to localhost:11434 (valid array input)" {
	cd "$REPO_ROOT"
	CANDIDATES_FILE="$TEST_TMP/candidates-import-safety-ok.json"
	echo '[{"name":"Import Safety Facility","facilityType":"data_center"}]' >"$CANDIDATES_FILE"

	# `timeout` is a defensive backstop only, not the real assertion below —
	# a refused connection to a closed localhost port fails near-instantly,
	# it would not hang.
	if [[ -n "$TIMEOUT_BIN" ]]; then
		run "$TIMEOUT_BIN" 10 npx tsx -e "$IMPORT_CHECK_SCRIPT" "$CANDIDATES_FILE"
	else
		run npx tsx -e "$IMPORT_CHECK_SCRIPT" "$CANDIDATES_FILE"
	fi

	[ "$status" -eq 0 ]
	[[ "$output" != *"ECONNREFUSED"* ]]
	[[ "$output" != *"11434"* ]]
	[[ "$output" != *"fetch failed"* ]]
	[[ "$output" != *"OLLAMA"* ]]
	# Exit-code 1 alone is ambiguous — main()'s own early "API_ADMIN_TOKEN is
	# not set" exit(1) coincides with the intentional invalid-array exit(1)
	# below, so these are the sharper, structural signal: they can ONLY
	# appear if `main()` ran in this "-e" context at all (a broken `isMain`
	# guard), which is the actual regression this test exists to catch —
	# confirmed by deliberately breaking `isMain` and re-running this file.
	[[ "$output" != *"API_ADMIN_TOKEN"* ]]
	[[ "$output" != *"Usage: submit-candidates.ts"* ]]
}

# --- multi-state batch (Unit 2, 2026-08-14) ----------------------------------
# STATES=(TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA) — starting at TX, a
# 2-state batch is [TX VA] and the cursor should land on OH (advance-by-2).

@test "STATES_PER_RUN=1 preserves today's single-state behavior" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	export STATES_PER_RUN=1
	echo "TX" >"$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	# exactly one candidates file written (one state processed)
	outfile_count="$(find "$LOG_DIR" -name 'candidates-*.json' | wc -l | tr -d ' ')"
	[ "$outfile_count" = "1" ]

	# cursor advances by exactly 1: TX -> VA
	cursor_after="$(cat "$LOG_DIR/cursor.txt" | tr -d ' \n')"
	[ "$cursor_after" = "VA" ]
}

@test "a 2-state batch processes both states and advances the cursor by 2" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	export STATES_PER_RUN=2
	echo "TX" >"$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	[[ "$output" == *"states=TX VA"* ]]

	# two distinct candidates files, one per state
	outfile_count="$(find "$LOG_DIR" -name 'candidates-*.json' | wc -l | tr -d ' ')"
	[ "$outfile_count" = "2" ]
	[ -n "$(find "$LOG_DIR" -name 'candidates-*-TX.json' -print -quit)" ]
	[ -n "$(find "$LOG_DIR" -name 'candidates-*-VA.json' -print -quit)" ]

	# TX VA -> next up is OH (index 0,1 consumed, cursor lands on index 2)
	cursor_after="$(cat "$LOG_DIR/cursor.txt" | tr -d ' \n')"
	[ "$cursor_after" = "OH" ]
}

@test "a 2-state batch wraps the rotation correctly at the end of the list" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	export STATES_PER_RUN=2
	# STATES=(TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA) — NM is index 13,
	# LA is index 14 (the last). A batch starting at NM must wrap to TX.
	echo "NM" >"$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	[[ "$output" == *"states=NM LA"* ]]
	cursor_after="$(cat "$LOG_DIR/cursor.txt" | tr -d ' \n')"
	[ "$cursor_after" = "TX" ]
}

@test "one state's claude failure does not prevent the other state in the batch from completing" {
	export DISCOVERY_ENABLED=true
	export STATES_PER_RUN=2
	echo "TX" >"$LOG_DIR/cursor.txt"

	# Batch is [TX VA]. TX's primary AND retry attempt (calls 1-2) fail with a
	# session-limit-style nonzero exit and no array; VA's primary attempt
	# (call 3) succeeds with a valid array — proving TX's total failure does
	# not stop VA from running to completion. A dedicated counter file (not
	# wc -l on CLAUDE_CALL_LOG) tracks the call number, since the prompt text
	# logged per call spans many lines on its own.
	CLAUDE_COUNTER_FILE="$TEST_TMP/claude-call-count"
	echo 0 >"$CLAUDE_COUNTER_FILE"
	cat >"$BIN_DIR/claude" <<EOF
#!/usr/bin/env bash
echo "claude \$*" >> "$CLAUDE_CALL_LOG"
n="\$(cat "$CLAUDE_COUNTER_FILE")"
n=\$((n + 1))
echo "\$n" >"$CLAUDE_COUNTER_FILE"
if [ "\$n" -le 2 ]; then
	echo "You've hit your session limit"
	exit 1
else
	echo '[{"name":"Second State Facility","facilityType":"data_center"}]'
	exit 0
fi
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	# TX failed, so the batch exit status is 1 — but VA still ran to
	# completion, which is what this test actually guards.
	[ "$status" -eq 1 ]

	# three claude calls total: TX primary, TX retry, VA primary
	call_count="$(cat "$CLAUDE_COUNTER_FILE")"
	[ "$call_count" -eq 3 ]

	# both states reached completion despite TX's total claude failure
	[[ "$output" == *"discovery batch complete"* ]]
	[[ "$output" == *"skipping submit"* ]]

	# only VA's candidates made it to submit (TX skipped — no parseable array)
	run grep -c -- "submit-candidates.ts .*--run-id" "$NPX_CALL_LOG"
	[ "$status" -eq 0 ]
	[ "${output//[[:space:]]/}" = "1" ]
	run grep -- "submit-candidates.ts .*--run-id" "$NPX_CALL_LOG"
	[[ "$output" == *"--state=VA"* ]]
}

@test "batch heartbeat records one entry per state with per-state claudeStatus" {
	export DISCOVERY_ENABLED=true
	export STATES_PER_RUN=2
	echo "TX" >"$LOG_DIR/cursor.txt"

	# Same TX-fails-twice / VA-succeeds shape as the isolation test above, so
	# the batch produces one no_array entry and one ok entry.
	CLAUDE_COUNTER_FILE="$TEST_TMP/claude-call-count"
	echo 0 >"$CLAUDE_COUNTER_FILE"
	cat >"$BIN_DIR/claude" <<EOF
#!/usr/bin/env bash
echo "claude \$*" >> "$CLAUDE_CALL_LOG"
n="\$(cat "$CLAUDE_COUNTER_FILE")"
n=\$((n + 1))
echo "\$n" >"$CLAUDE_COUNTER_FILE"
if [ "\$n" -le 2 ]; then
	echo "You've hit your session limit"
	exit 1
else
	echo '[{"name":"Heartbeat Facility","facilityType":"data_center"}]'
	exit 0
fi
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 1 ]

	[ -f "$LOG_DIR/heartbeat.json" ]
	grep -q '"lastRunAt"' "$LOG_DIR/heartbeat.json"
	grep -q '"state": "TX"' "$LOG_DIR/heartbeat.json"
	grep -q '"state": "VA"' "$LOG_DIR/heartbeat.json"
	grep -q '"claudeStatus": "no_array"' "$LOG_DIR/heartbeat.json"
	grep -q '"claudeStatus": "ok"' "$LOG_DIR/heartbeat.json"

	# must stay valid JSON
	run node -e "JSON.parse(require('fs').readFileSync('$LOG_DIR/heartbeat.json', 'utf8'))"
	[ "$status" -eq 0 ]
}

@test "importing submit-candidates.ts via tsx -e attempts no connection to localhost:11434 (unparseable input)" {
	cd "$REPO_ROOT"
	CANDIDATES_FILE="$TEST_TMP/candidates-import-safety-bad.json"
	echo 'not an array at all' >"$CANDIDATES_FILE"

	if [[ -n "$TIMEOUT_BIN" ]]; then
		run "$TIMEOUT_BIN" 10 npx tsx -e "$IMPORT_CHECK_SCRIPT" "$CANDIDATES_FILE"
	else
		run npx tsx -e "$IMPORT_CHECK_SCRIPT" "$CANDIDATES_FILE"
	fi

	[ "$status" -eq 1 ]
	[[ "$output" != *"ECONNREFUSED"* ]]
	[[ "$output" != *"11434"* ]]
	[[ "$output" != *"fetch failed"* ]]
	[[ "$output" != *"OLLAMA"* ]]
	# See the sibling test above — exit(1) is ambiguous on its own between
	# "correctly detected a non-array" and "main() crashed for an unrelated
	# reason"; this is the assertion that actually discriminates the two.
	[[ "$output" != *"API_ADMIN_TOKEN"* ]]
	[[ "$output" != *"Usage: submit-candidates.ts"* ]]
}

# --- alerting (open item #1, 2026-08-14) -------------------------------------
# heartbeat.json recorded claudeStatus=no_array every day for SIX consecutive
# days and nothing surfaced it: a totally failed run and a perfect one were
# indistinguishable from outside — both logged, both wrote a heartbeat, both
# exited 0. These tests pin the two halves of the fix (notification + nonzero
# exit) AND the negative case, which is the one that matters most: an alert
# that fires on healthy runs gets ignored and is worth nothing.

@test "a run that stages nothing fires a desktop notification and exits nonzero" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo "You've hit your session limit"
exit 1
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 1 ]
	[ -s "$NOTIFY_CALL_LOG" ]
	grep -q "Compute Atlas discovery FAILED" "$NOTIFY_CALL_LOG"
	[[ "$output" == *"FAIL: discovery run finished with 1 failure"* ]]
	[[ "$output" == *"no parseable candidate array"* ]]
}

@test "a clean run fires NO notification and exits 0" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Clean Run Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$NOTIFY_CALL_LOG" ]
	[[ "$output" == *"discovery run OK — no failures"* ]]
	grep -q '"status": "ok"' "$LOG_DIR/heartbeat.json"
	grep -q '"failureCount": 0' "$LOG_DIR/heartbeat.json"
}

@test "the alert and exit status come AFTER submit, source-liveness and heartbeat" {
	export DISCOVERY_ENABLED=true
	# A failing run must still do every piece of work a passing one does —
	# alerting must never cost the pipeline output it would otherwise produce.
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo "You've hit your session limit"
exit 1
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 1 ]
	grep -q "check-sources.ts" "$NPX_CALL_LOG"
	[ -f "$LOG_DIR/heartbeat.json" ]
	run node -e "JSON.parse(require('fs').readFileSync('$LOG_DIR/heartbeat.json', 'utf8'))"
	[ "$status" -eq 0 ]
}

@test "a stale heartbeat surfaces missed runs on the next run that happens" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	# BSD (macOS) then GNU (Linux/CI) — this file must pass on both.
	old="$(date -j -v-5d '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null \
		|| date -d '5 days ago' '+%Y-%m-%dT%H:%M:%S%z')"
	printf '{\n  "lastRunAt": "%s",\n  "states": []\n}\n' "$old" >"$LOG_DIR/heartbeat.json"

	run bash "$RUN_SH"
	# Missed PRIOR runs do not make THIS run a failure — it is reported, not
	# punished. Exit stays 0 because this run itself was fine.
	[ "$status" -eq 0 ]
	[[ "$output" == *"scheduled runs were MISSED"* ]]
	[ -s "$NOTIFY_CALL_LOG" ]
	grep -q "Missed runs" "$NOTIFY_CALL_LOG"
}

@test "a fresh heartbeat does not report missed runs" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	now="$(date '+%Y-%m-%dT%H:%M:%S%z')"
	printf '{\n  "lastRunAt": "%s",\n  "states": []\n}\n' "$now" >"$LOG_DIR/heartbeat.json"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" != *"scheduled runs were MISSED"* ]]
	[ ! -s "$NOTIFY_CALL_LOG" ]
}

# --- wall-clock cap enforcement (open item #2, 2026-08-14) -------------------
# MEASURED: against a process that ignores SIGTERM, `timeout 2` let it run the
# full 31s and STILL exited 124. So (a) -k is what actually enforces, and
# (b) exit status can never detect a cap that failed — only wall-clock can.

@test "the claude invocation passes --kill-after so SIGTERM-ignoring processes are SIGKILLed" {
	export DISCOVERY_ENABLED=true
	TIMEOUT_CALL_LOG="$TEST_TMP/timeout-calls.log"
	# Shim `timeout` to record its own arguments (which the `claude` shim
	# cannot see) and then pass through to the wrapped command.
	cat >"$BIN_DIR/timeout" <<EOF
#!/usr/bin/env bash
echo "timeout \$*" >>"$TIMEOUT_CALL_LOG"
shift 3   # -k <kill-after> <duration>
exec "\$@"
EOF
	chmod +x "$BIN_DIR/timeout"
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Kill After Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ -s "$TIMEOUT_CALL_LOG" ]
	grep -q -- "-k " "$TIMEOUT_CALL_LOG"
}

@test "a claude call that outlives the cap is reported as a cap-enforcement failure" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_TIMEOUT_SECS=1
	export DISCOVERY_KILL_AFTER_SECS=1
	export DISCOVERY_OVERRUN_GRACE_SECS=1   # overrun limit = 3s
	# Reproduces the 2026-08-11/12 signature: the machine slept, macOS paused
	# ITIMER_REAL, and `timeout` never fired despite the cap elapsing (runs of
	# 106 min against a 600s cap). Shimming `timeout` to pass straight through
	# makes the cap provably do nothing, which is the condition under test.
	cat >"$BIN_DIR/timeout" <<'EOF'
#!/usr/bin/env bash
shift 3
exec "$@"
EOF
	chmod +x "$BIN_DIR/timeout"
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
sleep 5
echo '[{"name":"Overrun Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	# NOTE the shape: this run produced a perfectly valid candidate array and
	# submitted it, so claudeStatus is "ok" — and it STILL fails. An overrun is
	# a failure of the guard, not of the output, and the old code could not see
	# the difference at all.
	[ "$status" -eq 1 ]
	[[ "$output" == *"the wall-clock cap did NOT enforce"* ]]
	[ -s "$NOTIFY_CALL_LOG" ]
	grep -q '"claudeStatus": "ok"' "$LOG_DIR/heartbeat.json"
	grep -q '"status": "degraded"' "$LOG_DIR/heartbeat.json"
}

@test "a claude call within the cap is NOT reported as an overrun" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_TIMEOUT_SECS=30
	export DISCOVERY_KILL_AFTER_SECS=5
	export DISCOVERY_OVERRUN_GRACE_SECS=5
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Fast Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" != *"did NOT enforce"* ]]
	[ ! -s "$NOTIFY_CALL_LOG" ]
}

@test "per-state wall-clock lands in the heartbeat" {
	export DISCOVERY_ENABLED=true
	cat >"$BIN_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $*" >> "$CLAUDE_CALL_LOG"
echo '[{"name":"Elapsed Facility","facilityType":"data_center"}]'
exit 0
EOF
	chmod +x "$BIN_DIR/claude"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	grep -q '"elapsedSecs"' "$LOG_DIR/heartbeat.json"
	run node -e "
		const hb = JSON.parse(require('fs').readFileSync('$LOG_DIR/heartbeat.json', 'utf8'));
		if (typeof hb.states[0].elapsedSecs !== 'number') process.exit(1);
	"
	[ "$status" -eq 0 ]
}

# --- rotation rebalance (2026-08-14) ----------------------------------------
# The prior 15-state rotation held 555 of 941 live facilities; the other 386
# lived in states the pipeline NEVER visited. Note every test above pins
# DISCOVERY_STATES to the OLD list (see setup()) because they test cursor
# MECHANICS; these two are the ones that assert list CONTENT.

@test "the default rotation adds the unvisited hyperscaler states without dropping any" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	unset DISCOVERY_STATES
	rm -f "$LOG_DIR/cursor.txt"
	export STATES_PER_RUN=99   # clamped to the rotation length — visits all

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	# newly added: the major hyperscaler markets that had zero attention
	for s in IA NE WA OR MN MO UT; do
		[[ "$output" == *"for state=$s"* ]] || {
			echo "missing newly-added state: $s"
			false
		}
	done
	# and nothing was removed — dropping TX/VA would silently stop re-checking
	# their 216 facilities for status changes
	for s in TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA; do
		[[ "$output" == *"for state=$s"* ]] || {
			echo "default rotation dropped state: $s"
			false
		}
	done
}

@test "DISCOVERY_STATES drives a targeted manual run without editing the script" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	export DISCOVERY_STATES="IA NE"
	export STATES_PER_RUN=2
	rm -f "$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"states=IA NE"* ]]
	[ -n "$(find "$LOG_DIR" -name 'candidates-*-IA.json' -print -quit)" ]
	[ -n "$(find "$LOG_DIR" -name 'candidates-*-NE.json' -print -quit)" ]
	# no state outside the override was touched
	[ -z "$(find "$LOG_DIR" -name 'candidates-*-TX.json' -print -quit)" ]
}

@test "a whitespace-only DISCOVERY_STATES falls back to the default rotation instead of doing nothing" {
	export DISCOVERY_ENABLED=true
	export DISCOVERY_DRY_RUN=true
	# Deliberately whitespace, not "" — `${DISCOVERY_STATES:-...}` already
	# treats an empty value as unset, so "" can never reach the guard. A
	# whitespace-only value DOES: it is non-empty to the shell but expands to
	# zero array elements, which would otherwise make the run silently
	# process no states at all.
	export DISCOVERY_STATES="   "
	export STATES_PER_RUN=1
	rm -f "$LOG_DIR/cursor.txt"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"falling back to the default rotation"* ]]
	# it actually processed a state rather than silently no-opping
	outfile_count="$(find "$LOG_DIR" -name 'candidates-*.json' | wc -l | tr -d ' ')"
	[ "$outfile_count" = "1" ]
}
