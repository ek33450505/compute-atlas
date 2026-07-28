#!/usr/bin/env bats
# Coverage for scripts/seo-runner/run-session.sh control flow — the
# fail-closed switch, scope guard, resume/no-reset logic, and the merge gate
# (green/red, attended/unattended, auto-advance on an out-of-band merge).
# Every test isolates HOME, shims git/gh/claude/osascript/sqlite3 so ZERO
# real git, network, claude, notification, or db calls ever happen, and
# points SEO_RUNNER_LOG_DIR + SEO_STATE_FILE at temp paths so the real repo
# and plans/.seo-runner-state.json are never touched. `python3` +
# scripts/seo-runner/state.py run for REAL (pure stdlib JSON I/O against the
# temp state file), so the actual next/set behavior is exercised, not mocked.

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	RUN_SH="$REPO_ROOT/scripts/seo-runner/run-session.sh"

	TEST_TMP="$(mktemp -d)"
	HOME="$TEST_TMP/home"
	mkdir -p "$HOME"

	LOG_DIR="$TEST_TMP/seo-runner-logs"
	mkdir -p "$LOG_DIR"

	SEO_STATE_FILE="$TEST_TMP/seo-state.json"

	BIN_DIR="$TEST_TMP/bin"
	mkdir -p "$BIN_DIR"

	GIT_CALL_LOG="$TEST_TMP/git-calls.log"
	GH_CALL_LOG="$TEST_TMP/gh-calls.log"
	CLAUDE_CALL_LOG="$TEST_TMP/claude-calls.log"
	SQLITE3_CALL_LOG="$TEST_TMP/sqlite3-calls.log"

	# --- fake `git`: logs every invocation (so a test can assert e.g.
	# `checkout -B` was NOT called on a resume path) and never touches the
	# real repo's git state. `status --porcelain` / `show-ref` are steerable
	# via FAKE_GIT_DIRTY / FAKE_LOCAL_REF_EXISTS / FAKE_REMOTE_REF_EXISTS;
	# every other git subcommand (checkout, checkout -B/-b, pull, fetch)
	# just succeeds. ----------------------------------------------------------
	cat >"$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
echo "git \$*" >>"$GIT_CALL_LOG"
case "\$*" in
*"status --porcelain"*)
	if [ "\${FAKE_GIT_DIRTY:-0}" = "1" ]; then
		echo " M some-dirty-file.txt"
	fi
	exit 0
	;;
*"show-ref --verify --quiet refs/heads/"*)
	[ "\${FAKE_LOCAL_REF_EXISTS:-0}" = "1" ] && exit 0 || exit 1
	;;
*"show-ref --verify --quiet refs/remotes/origin/"*)
	[ "\${FAKE_REMOTE_REF_EXISTS:-0}" = "1" ] && exit 0 || exit 1
	;;
*)
	exit 0
	;;
esac
EOF
	chmod +x "$BIN_DIR/git"

	# --- fake `gh`: `pr view ... --json number,state` (resume detection) and
	# `--json mergeable` (merge gate) return test-controlled values via
	# FAKE_PR_NUMBER / FAKE_PR_STATE / FAKE_MERGEABLE; `pr checks` (non-watch)
	# exits FAKE_CI_EXIT; `pr create` / `pr merge` / `pr checks --watch` just
	# succeed. Every call is logged so a test can assert `pr merge` was or
	# wasn't invoked, and with which flags. ------------------------------------
	cat >"$BIN_DIR/gh" <<EOF
#!/usr/bin/env bash
echo "gh \$*" >>"$GH_CALL_LOG"
case "\$*" in
*"pr create"*)
	exit "\${FAKE_PR_CREATE_EXIT:-0}"
	;;
*"pr merge"*)
	exit 0
	;;
*"pr checks"*"--watch"*)
	exit 0
	;;
*"pr checks"*)
	exit "\${FAKE_CI_EXIT:-0}"
	;;
*"--json number,state"*)
	echo "{\"number\": \${FAKE_PR_NUMBER:-42}, \"state\": \"\${FAKE_PR_STATE:-OPEN}\"}"
	exit 0
	;;
*"--json mergeable"*)
	echo "\${FAKE_MERGEABLE:-MERGEABLE}"
	exit 0
	;;
*"--json number"*)
	echo "\${FAKE_PR_NUMBER:-42}"
	exit 0
	;;
*)
	exit 0
	;;
esac
EOF
	chmod +x "$BIN_DIR/gh"

	# --- fake `claude`: logs args, echoes FAKE_CLAUDE_OUTPUT to stdout (which
	# run-session.sh pipes into its per-run, timestamped orchestrate log) so
	# tests can drive the merge gate's grep sentinel without guessing that
	# filename. Must NEVER be invoked in DRY_RUN or a SKIP_ORCHESTRATE
	# (resume-with-already-open-PR) path. --------------------------------------
	cat >"$BIN_DIR/claude" <<EOF
#!/usr/bin/env bash
echo "claude \$*" >>"$CLAUDE_CALL_LOG"
echo "\${FAKE_CLAUDE_OUTPUT:-orchestrate session completed successfully}"
exit "\${FAKE_CLAUDE_EXIT:-0}"
EOF
	chmod +x "$BIN_DIR/claude"

	# --- fake `osascript`: no-op stub (GUI-notification shim rule). ----------
	cat >"$BIN_DIR/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
	chmod +x "$BIN_DIR/osascript"

	# --- fake `sqlite3`: must NEVER be invoked — its presence on PATH is a
	# regression trap proving the merge gate stays CI + mergeable + grep
	# only, never cast.db. ------------------------------------------------------
	cat >"$BIN_DIR/sqlite3" <<EOF
#!/usr/bin/env bash
echo "SQLITE3 CALLED: \$*" >>"$SQLITE3_CALL_LOG"
exit 0
EOF
	chmod +x "$BIN_DIR/sqlite3"

	export HOME LOG_DIR SEO_STATE_FILE GIT_CALL_LOG GH_CALL_LOG CLAUDE_CALL_LOG SQLITE3_CALL_LOG
	export PATH="$BIN_DIR:$PATH"
	export SEO_RUNNER_LOG_DIR="$LOG_DIR"
}

teardown() {
	rm -rf "$TEST_TMP"
}

# seed_state <status> [branch]: writes a single-session state file. Default
# branch matches the scope guard so tests only have to override it when they
# specifically want a rejection case.
seed_state() {
	local status="$1"
	local branch="${2:-feature/seo-test-session}"
	cat >"$SEO_STATE_FILE" <<EOF
{
  "current": null,
  "sessions": [
    {"id": "test-session", "branch": "$branch", "title": "test(seo): a test session", "status": "$status", "pr": null, "updated": ""}
  ]
}
EOF
}

session_status() {
	python3 -c "import json; print(json.load(open('$SEO_STATE_FILE'))['sessions'][0]['status'])"
}

# --- MUST-HAVE 1: fail-closed master switch ----------------------------------
@test "SEO_RUNNER_ENABLED unset exits 0 with no git/gh/claude calls" {
	unset SEO_RUNNER_ENABLED || true
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$GIT_CALL_LOG" ]
	[ ! -s "$GH_CALL_LOG" ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

# --- MUST-HAVE 2: DISABLED sentinel ------------------------------------------
@test "LOG_DIR/DISABLED sentinel short-circuits even when enabled" {
	export SEO_RUNNER_ENABLED=true
	touch "$LOG_DIR/DISABLED"
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[ ! -s "$GIT_CALL_LOG" ]
	[ ! -s "$GH_CALL_LOG" ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

# --- MUST-HAVE 3: scope guard -------------------------------------------------
@test "scope guard refuses a non-SEO branch" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	seed_state pending "main"
	run bash "$RUN_SH"
	[ "$status" -eq 1 ]
	[[ "$output" == *"SCOPE GUARD"* ]]
	[ ! -s "$GH_CALL_LOG" ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

# --- MUST-HAVE 4: green gate + UNATTENDED=1 merges ---------------------------
@test "green gate + UNATTENDED=1 merges exactly once with --squash --delete-branch, never --admin/--force" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_CI_EXIT=0
	export FAKE_MERGEABLE=MERGEABLE
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	merge_calls="$(grep -c "pr merge" "$GH_CALL_LOG")"
	[ "$merge_calls" -eq 1 ]
	grep -q -- "--squash" "$GH_CALL_LOG"
	grep -q -- "--delete-branch" "$GH_CALL_LOG"
	! grep -q -- "--admin" "$GH_CALL_LOG"
	! grep -q -- "--force" "$GH_CALL_LOG"

	[ "$(session_status)" = "merged" ]
}

# --- MUST-HAVE 5: red gate + UNATTENDED=1 never merges -----------------------
@test "red gate (CI failing) + UNATTENDED=1 never merges, marks session failed" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_CI_EXIT=1
	export FAKE_MERGEABLE=MERGEABLE
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 1 ]
	[[ "$output" == *"merge gate failed"* ]]

	run grep -c "pr merge" "$GH_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]

	[ "$(session_status)" = "failed" ]
}

# --- MUST-HAVE 6: merge gate never touches cast.db ---------------------------
@test "merge gate never consults cast.db (sqlite3 stub never invoked)" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_CI_EXIT=0
	export FAKE_MERGEABLE=MERGEABLE
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	grep -q "pr merge" "$GH_CALL_LOG"
	[ ! -s "$SQLITE3_CALL_LOG" ]
}

# --- MUST-HAVE 7: dirty working tree ------------------------------------------
@test "dirty working tree refuses to run" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_GIT_DIRTY=1
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 1 ]
	[[ "$output" == *"working tree dirty"* ]]
	[ ! -s "$GH_CALL_LOG" ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

# --- SHOULD-HAVE 8: DRY_RUN is side-effect-free ------------------------------
@test "SEO_RUNNER_DRY_RUN=true is a side-effect-free early exit" {
	export SEO_RUNNER_ENABLED=true
	export SEO_RUNNER_DRY_RUN=true
	export UNATTENDED=1
	seed_state pending
	cp "$SEO_STATE_FILE" "$TEST_TMP/state-before.json"

	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"DRY_RUN"* ]]
	[ ! -s "$CLAUDE_CALL_LOG" ]
	[ ! -s "$GH_CALL_LOG" ]

	diff "$TEST_TMP/state-before.json" "$SEO_STATE_FILE"
}

# --- SHOULD-HAVE 9: attended pause --------------------------------------------
@test "green gate without UNATTENDED pauses attended and does not merge" {
	export SEO_RUNNER_ENABLED=true
	unset UNATTENDED || true
	export FAKE_CI_EXIT=0
	export FAKE_MERGEABLE=MERGEABLE
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"ATTENDED"* ]]
	! grep -q "pr merge" "$GH_CALL_LOG" 2>/dev/null

	[ "$(session_status)" = "pr_open" ]
}

# --- SHOULD-HAVE 10: resume never resets an open PR's branch -----------------
@test "resume of a pr_open OPEN session does not reset the branch and skips orchestrate" {
	export SEO_RUNNER_ENABLED=true
	export FAKE_PR_STATE=OPEN
	export FAKE_LOCAL_REF_EXISTS=1
	seed_state pr_open
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]

	run grep -c "checkout -B" "$GIT_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]
	[ ! -s "$CLAUDE_CALL_LOG" ]
}

# --- SHOULD-HAVE 11: resume auto-advances an out-of-band merge ---------------
@test "resume of a pr_open MERGED session auto-advances without re-invoking claude or merge" {
	export SEO_RUNNER_ENABLED=true
	export FAKE_PR_STATE=MERGED
	seed_state pr_open
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	[[ "$output" == *"auto-advanced"*"already merged"* ]]
	[ ! -s "$CLAUDE_CALL_LOG" ]

	run grep -c "pr merge" "$GH_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]

	[ "$(session_status)" = "merged" ]
}

# --- SHOULD-HAVE 12a: grep word-boundary — UNBLOCKED must not false-trigger --
@test "grep word-boundary: UNBLOCKED in the orchestrate log does not fail the gate" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_CI_EXIT=0
	export FAKE_MERGEABLE=MERGEABLE
	export FAKE_CLAUDE_OUTPUT="all systems UNBLOCKED, proceeding"
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 0 ]
	grep -q "pr merge" "$GH_CALL_LOG"
	[ "$(session_status)" = "merged" ]
}

# --- SHOULD-HAVE 12b: grep word-boundary — whole-word BLOCKED must trigger --
@test "grep word-boundary: whole-word BLOCKED in the orchestrate log fails the gate" {
	export SEO_RUNNER_ENABLED=true
	export UNATTENDED=1
	export FAKE_CI_EXIT=0
	export FAKE_MERGEABLE=MERGEABLE
	export FAKE_CLAUDE_OUTPUT="security review: BLOCKED pending fix"
	seed_state pending
	run bash "$RUN_SH"
	[ "$status" -eq 1 ]

	run grep -c "pr merge" "$GH_CALL_LOG"
	[ "$status" -ne 0 ] || [ "${output//[[:space:]]/}" = "0" ]
	[ "$(session_status)" = "failed" ]
}
