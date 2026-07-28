#!/usr/bin/env bash
# Track B0 self-driving SEO runner: advances the SEO visibility program
# (plans/seo-visibility-program.md) ONE /orchestrate session per invocation,
# opens a PR for it, and — only when every gate is green AND the run is
# explicitly unattended — squash-merges it to main. Fail-closed by default:
# does nothing unless SEO_RUNNER_ENABLED=true, and never merges unless
# UNATTENDED=1 is also set. The two operator-facing flags:
#
#   SEO_RUNNER_ENABLED=true   master switch (default: off, no-op)
#   UNATTENDED=1              actually squash-merge a green PR (default:
#                             off — leaves a green PR open for a manual
#                             `gh pr merge`)
#
# Other overrides (all optional, mostly for local/test runs):
#   SEO_RUNNER_DRY_RUN=true   skip the claude call, PR, CI watch, and merge
#                             entirely; just log what would happen
#   SEO_RUNNER_LOG_DIR        relocate seo-runner-logs/
#   SEO_STATE_FILE            relocate plans/.seo-runner-state.json
#   SEO_PROGRAM_FILE          relocate plans/seo-visibility-program.md
#
# Never force-merges, never acts on a non "feature/seo-*" branch, never
# writes live facility data, never reads or writes cast.db. Intended to run
# via launchd (see com.compute-atlas.seo-runner.plist) or manually for
# testing. Mirrors scripts/discovery/run.sh's shape and conventions.
set -euo pipefail

log() {
	echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

RUN_ID="$(date '+%Y%m%dT%H%M%S')"

LOG_DIR="${SEO_RUNNER_LOG_DIR:-$REPO_ROOT/seo-runner-logs}"
mkdir -p "$LOG_DIR"

STATE_FILE="${SEO_STATE_FILE:-$REPO_ROOT/plans/.seo-runner-state.json}"
PROGRAM_FILE="${SEO_PROGRAM_FILE:-plans/seo-visibility-program.md}"

# stop: logs $1 (stdout, $LOG_DIR/run.log, and ~/.claude/logs/seo-runner.log),
# fires a best-effort desktop notification, then exits $2 (default 1). Every
# side effect here is best-effort (`|| true`) — stop() must never itself
# fail to exit with the intended code.
stop() {
	local msg="$1"
	local code="${2:-1}"
	local line
	line="[$(date '+%Y-%m-%dT%H:%M:%S%z')] STOP: $msg"
	log "$msg"
	echo "$line" >>"$LOG_DIR/run.log" 2>/dev/null || true
	mkdir -p "$HOME/.claude/logs" 2>/dev/null || true
	echo "$line" >>"$HOME/.claude/logs/seo-runner.log" 2>/dev/null || true
	if command -v osascript >/dev/null 2>&1; then
		local safe_msg="${msg//\"/\'}"
		osascript -e "display notification \"$safe_msg\" with title \"seo-runner\"" >/dev/null 2>&1 || true
	fi
	exit "$code"
}

# seo_state_set: wraps `state.py set` so a state-write failure goes through
# stop() (logged + notified) instead of a bare `set -e` abort.
seo_state_set() {
	if ! python3 scripts/seo-runner/state.py set "$STATE_FILE" "$@" >>"$LOG_DIR/run.log" 2>&1; then
		stop "state.py set failed (args: $*)" 1
	fi
}

# --- fail-closed kill switch -------------------------------------------------
if [[ "${SEO_RUNNER_ENABLED:-false}" != "true" ]] || [[ -f "$LOG_DIR/DISABLED" ]]; then
	log "seo-runner disabled — skipping"
	exit 0
fi

# --- preconditions ------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
	stop "working tree dirty — refusing to run" 1
fi

if ! git checkout main >>"$LOG_DIR/run.log" 2>&1; then
	stop "git checkout main failed" 1
fi

if ! git pull --ff-only >>"$LOG_DIR/run.log" 2>&1; then
	stop "git pull --ff-only failed" 1
fi

# --- pick the next actionable session ----------------------------------------
set +e
SESSION_JSON="$(python3 scripts/seo-runner/state.py next "$STATE_FILE" 2>"$LOG_DIR/state-next.err")"
STATE_EXIT=$?
set -e

if [[ "$STATE_EXIT" -eq 3 ]]; then
	log "seo-runner program complete — no actionable session in $STATE_FILE"
	exit 0
elif [[ "$STATE_EXIT" -ne 0 ]]; then
	stop "state.py next failed (exit $STATE_EXIT) — see $LOG_DIR/state-next.err" 1
fi

# Extraction is expected to always succeed: state.py next only ever prints a
# session object matching the seeded shape. A malformed print here would be
# a bug in state.py itself, so this deliberately relies on `set -e` to abort
# rather than adding a redundant stop() path for a condition that should be
# unreachable.
SESSION_ID="$(printf '%s' "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
SESSION_BRANCH="$(printf '%s' "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["branch"])')"
SESSION_TITLE="$(printf '%s' "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])')"
SESSION_STATUS="$(printf '%s' "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"

log "next session: id=$SESSION_ID branch=$SESSION_BRANCH status=$SESSION_STATUS"

# --- scope guard (HARD): never act on a non-SEO branch -----------------------
# Anchored + charset-allowlisted (not just a prefix match) as defense in
# depth against a state file entry ever containing anything but a plain
# lowercase/digit/hyphen slug after "feature/seo-".
if [[ ! "$SESSION_BRANCH" =~ ^feature/seo-[a-z0-9-]+$ ]]; then
	stop "SCOPE GUARD: refusing non-SEO branch $SESSION_BRANCH" 1
fi

# --- resume detection ---------------------------------------------------------
# "running"/"pr_open" means a prior run started this session and didn't
# finish (or is mid-review) — resuming it must never reset the branch (that
# would discard commits or diverge from what's already pushed). A fresh
# "pending" session has nothing to preserve, so a hard reset from main is
# fine there.
IS_RESUME=false
if [[ "$SESSION_STATUS" == "running" ]] || [[ "$SESSION_STATUS" == "pr_open" ]]; then
	IS_RESUME=true
fi
SKIP_ORCHESTRATE=false
PR=""

# DRY_RUN is a side-effect-free early exit: no branch checkout, no state
# write, no gh/claude call. Must come before any of those, so it sits here —
# right after we know fresh-vs-resume, before we act on either.
if [[ "${SEO_RUNNER_DRY_RUN:-false}" == "true" ]]; then
	if [[ "$IS_RESUME" == "true" ]]; then
		log "DRY_RUN — would resume $SESSION_STATUS session id=$SESSION_ID on $SESSION_BRANCH: check existing PR state, then open/resume PR, watch CI, and merge iff UNATTENDED=1 and all gates pass"
	else
		log "DRY_RUN — would start fresh session id=$SESSION_ID on $SESSION_BRANCH: checkout -B from main, orchestrate, open PR, watch CI, and merge iff UNATTENDED=1 and all gates pass"
	fi
	log "DRY_RUN — no branch checkout, state write, or gh/claude call performed"
	exit 0
fi

if [[ "$IS_RESUME" == "true" ]]; then
	# Check whether the PR already resolved without us (e.g. an attended
	# manual merge happened since the last tick) so a merged session never
	# stays zombied as pr_open forever, and a session someone explicitly
	# closed doesn't get silently retried forever either.
	EXISTING_PR="$(gh pr view "$SESSION_BRANCH" --json number,state 2>/dev/null || echo "")"

	if [[ -n "$EXISTING_PR" ]]; then
		PR="$(printf '%s' "$EXISTING_PR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["number"])')"
		PR_STATE="$(printf '%s' "$EXISTING_PR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"

		if [[ "$PR_STATE" == "MERGED" ]]; then
			seo_state_set "$SESSION_ID" merged --pr "$PR"
			log "auto-advanced: PR #$PR already merged"
			exit 0
		elif [[ "$PR_STATE" == "CLOSED" ]]; then
			seo_state_set "$SESSION_ID" failed --pr "$PR"
			stop "PR #$PR CLOSED without merge — needs attention" 1
		else
			SKIP_ORCHESTRATE=true
			log "PR #$PR open — resuming at CI watch + gate, not rebuilding"
		fi
	fi

	# Check out the branch WITHOUT resetting — preserve whatever commits are
	# already there, whether local (same machine, interrupted mid-run) or
	# only on the remote (fresh clone/machine).
	git fetch origin "$SESSION_BRANCH" >>"$LOG_DIR/run.log" 2>&1 || true
	if git show-ref --verify --quiet "refs/heads/$SESSION_BRANCH"; then
		if ! git checkout "$SESSION_BRANCH" >>"$LOG_DIR/run.log" 2>&1; then
			stop "git checkout $SESSION_BRANCH failed" 1
		fi
	elif git show-ref --verify --quiet "refs/remotes/origin/$SESSION_BRANCH"; then
		if ! git checkout -b "$SESSION_BRANCH" "origin/$SESSION_BRANCH" >>"$LOG_DIR/run.log" 2>&1; then
			stop "git checkout -b $SESSION_BRANCH origin/$SESSION_BRANCH failed" 1
		fi
	else
		# Nothing local or remote to preserve — same as a fresh session.
		if ! git checkout -B "$SESSION_BRANCH" main >>"$LOG_DIR/run.log" 2>&1; then
			stop "git checkout -B $SESSION_BRANCH failed" 1
		fi
	fi
else
	# Fresh "pending" session: nothing to preserve, so resetting from main
	# is safe and intended (guarantees a clean base for this run).
	if ! git checkout -B "$SESSION_BRANCH" main >>"$LOG_DIR/run.log" 2>&1; then
		stop "git checkout -B $SESSION_BRANCH failed" 1
	fi
fi

seo_state_set "$SESSION_ID" running

# --- orchestrate --------------------------------------------------------------
ORCH_LOG="$LOG_DIR/orchestrate-$RUN_ID.log"

if [[ "$SKIP_ORCHESTRATE" != "true" ]]; then
	ORCH_PROMPT="Run the /orchestrate skill on $PROGRAM_FILE, executing ONLY the manifest block whose target_branch is $SESSION_BRANCH (session $SESSION_ID). Run that session's batches in order; do not run any other session's manifest."

	# ASCII-only on purpose: launchd runs with a bare/C locale (mirrors
	# scripts/discovery/run.sh's BATCH_CONTRACT rationale).
	CONTRACT="You are a non-interactive orchestration runner. Execute only the requested session's manifest. Reviewer and security verdicts are TEXT only; do NOT write cast.db review markers. The gitignored, never-committed .env.local Neon credential is a KNOWN non-issue: a trufflehog --only-verified hit on it is NOT a blocker; only a NEW secret introduced in THIS diff blocks. Do not write any journal entry. Do not touch the submissions table or approve data."

	# macOS ships neither `timeout` nor `gtimeout` by default — prefer
	# whichever exists; if neither, run uncapped but say so (mirrors
	# discovery/run.sh).
	TIMEOUT_BIN=""
	if command -v timeout >/dev/null 2>&1; then
		TIMEOUT_BIN="timeout"
	elif command -v gtimeout >/dev/null 2>&1; then
		TIMEOUT_BIN="gtimeout"
	fi

	set +e
	if [[ -n "$TIMEOUT_BIN" ]]; then
		"$TIMEOUT_BIN" 5400 claude -p "$ORCH_PROMPT" --append-system-prompt "$CONTRACT" --output-format text </dev/null 2>&1 | tee "$ORCH_LOG"
	else
		log "WARN: no timeout/gtimeout binary found — running claude without a wall-clock cap"
		claude -p "$ORCH_PROMPT" --append-system-prompt "$CONTRACT" --output-format text </dev/null 2>&1 | tee "$ORCH_LOG"
	fi
	ORCH_EXIT="${PIPESTATUS[0]}"
	set -e

	if [[ "$ORCH_EXIT" -ne 0 ]]; then
		stop "orchestrate run failed for $SESSION_BRANCH (exit $ORCH_EXIT) — see $ORCH_LOG; session left running for auto-retry next tick" 1
	fi
else
	log "SKIP_ORCHESTRATE — PR #$PR already open for $SESSION_BRANCH, resuming at CI watch"
fi

# --- open PR -------------------------------------------------------------------
if [[ -z "$PR" ]]; then
	# `gh pr create` can legitimately fail with "already exists" when
	# resuming a running session whose PR got opened by an interrupted
	# prior run — that's fine, `gh pr view` below is the actual source of
	# truth for the PR number either way.
	gh pr create --base main --head "$SESSION_BRANCH" --title "$SESSION_TITLE" \
		--body "Auto-generated by seo-runner (Track B0); agent-reviewed inside the manifest; code-only, no data writes." \
		>>"$LOG_DIR/run.log" 2>&1 || log "gh pr create did not open a new PR for $SESSION_BRANCH (may already exist) — falling back to gh pr view"

	PR="$(gh pr view "$SESSION_BRANCH" --json number -q .number 2>>"$LOG_DIR/run.log" || echo "")"

	if [[ -z "$PR" ]]; then
		stop "no open PR found for $SESSION_BRANCH after gh pr create — nothing was pushed?" 1
	fi
else
	log "PR #$PR already open for $SESSION_BRANCH — skipping gh pr create"
fi

seo_state_set "$SESSION_ID" pr_open --pr "$PR"
log "PR #$PR open for $SESSION_BRANCH"

# --- watch CI --------------------------------------------------------------
gh pr checks "$PR" --watch >>"$LOG_DIR/run.log" 2>&1 || true

CI_OK=true
gh pr checks "$PR" >>"$LOG_DIR/run.log" 2>&1 || CI_OK=false

MERGEABLE="$(gh pr view "$PR" --json mergeable -q .mergeable 2>>"$LOG_DIR/run.log" || echo "")"

# --- merge gate (fail-closed) --------------------------------------------------
# This gate is CI + `gh`'s own mergeable computation + a best-effort text
# sentinel over the orchestrate transcript — and NOTHING from cast.db. It
# must stay that way: the security agent's trufflehog step unconditionally
# flags the gitignored, never-committed .env.local Neon credential, so keying
# this gate on cast.db "rejected" review markers would false-red on that hit
# every single run. CONTRACT above tells the manifest's own security pass to
# treat that hit as a known non-issue in its TEXT verdict, but this gate does
# not even trust that — it independently re-checks CI + mergeable, and only
# uses the transcript grep as a secondary, best-effort net.
GATE_OK=true
if [[ "$CI_OK" != "true" ]]; then
	GATE_OK=false
fi
if [[ "$MERGEABLE" != "MERGEABLE" ]]; then
	GATE_OK=false
fi
# -w (word boundary) so e.g. "UNBLOCKED" doesn't false-trigger the gate.
if grep -qiwE 'BLOCKED|gate failed|review reject' "$ORCH_LOG" 2>/dev/null; then
	GATE_OK=false
fi

if [[ "$GATE_OK" == "true" ]] && [[ "${UNATTENDED:-0}" == "1" ]]; then
	if ! gh pr merge "$PR" --squash --delete-branch >>"$LOG_DIR/run.log" 2>&1; then
		stop "gh pr merge failed for PR #$PR after the gate passed — check manually" 1
	fi
	seo_state_set "$SESSION_ID" merged --pr "$PR"
	log "merged PR #$PR for $SESSION_BRANCH (UNATTENDED=1)"
	exit 0
elif [[ "$GATE_OK" == "true" ]]; then
	log "ATTENDED: PR #$PR is green + mergeable — review then run: gh pr merge $PR --squash --delete-branch  (or re-run with UNATTENDED=1). After a manual merge, the next scheduled run auto-advances this session by detecting the merged PR — or run: python3 scripts/seo-runner/state.py set $STATE_FILE $SESSION_ID merged  to advance immediately."
	exit 0
else
	seo_state_set "$SESSION_ID" failed --pr "$PR"
	stop "merge gate failed for PR #$PR — left open, not merged" 1
fi
