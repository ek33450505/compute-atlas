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

	export HOME LOG_DIR CLAUDE_CALL_LOG NPX_CALL_LOG
	export PATH="$BIN_DIR:$PATH"
	export DISCOVERY_LOG_DIR="$LOG_DIR"
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
	[ "$status" -eq 0 ]
	[[ "$output" == *"discovery run"*"complete"* ]]
	[[ "$output" == *"skipping submit"* ]]
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
	[ "$status" -eq 0 ]

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
	[ "$status" -eq 0 ]

	[ -f "$LOG_DIR/heartbeat.json" ]
	grep -q '"claudeStatus": "no_array"' "$LOG_DIR/heartbeat.json"
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
# injectable from the test — so exact --max=10 assertions are clock-fragile
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

	# the submit call's --max is one of the two sane values (10 during the
	# burst window, 5 after) — never empty, never something else
	run grep -Eo -- "submit-candidates.ts .*--max=(10|5)" "$NPX_CALL_LOG"
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
