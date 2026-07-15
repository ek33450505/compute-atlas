#!/usr/bin/env bats
# Coverage for scripts/discovery/run.sh orchestration (control flow only —
# existing-facilities.ts / check-sources.ts / submit-candidates.ts are unit
# tested separately in Vitest). Every test isolates HOME, shims `claude` and
# `npx` so ZERO real network calls or claude invocations ever happen, and
# points LOG_DIR at a temp dir so the real discovery-logs/ is never touched.

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	RUN_SH="$REPO_ROOT/scripts/discovery/run.sh"

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
	cat >"$BIN_DIR/npx" <<'EOF'
#!/usr/bin/env bash
echo "npx $*" >>"$NPX_CALL_LOG"
case "$*" in
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
