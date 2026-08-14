#!/usr/bin/env bash
# Scheduled harness for the discovery pipeline. Fail-closed by default: does
# nothing unless DISCOVERY_ENABLED=true. Never writes live facilities — the
# submit step only ever POSTs to /api/submissions (Phase 4 staging queue),
# and the discovery step itself is read-only research. Never git commits or
# pushes. Intended to be run by launchd (see com.compute-atlas.discovery.plist)
# or manually for testing.
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="${DISCOVERY_LOG_DIR:-$REPO_ROOT/discovery-logs}"
mkdir -p "$LOG_DIR"

# --- fail-closed kill switch -------------------------------------------------
if [[ "${DISCOVERY_ENABLED:-false}" != "true" ]] || [[ -f "$LOG_DIR/DISABLED" ]]; then
  log "discovery disabled — skipping"
  exit 0
fi

# --- state rotation cursor ---------------------------------------------------
STATES=(TX VA OH GA AZ NV NC PA IL WI IN OK WY NM LA)
CURSOR_FILE="$LOG_DIR/cursor.txt"

# STATES_PER_RUN: how many states this invocation processes, each with its own
# claude call/submit. Default 2 (2026-08-14, ~3x daily-output push — the other
# ~1.5x comes from the raised review cap below). Env-overridable for tests/
# tuning. Clamped to [1, ${#STATES[@]}] so a bad value (0, negative, or bigger
# than the rotation) can't loop forever or index out of STATES' bounds. With
# 15 states, a step of 2 doesn't divide evenly — pairings vary cycle to cycle,
# which is fine and intended, not a bug.
STATES_PER_RUN="${STATES_PER_RUN:-2}"
(( STATES_PER_RUN < 1 )) && STATES_PER_RUN=1
(( STATES_PER_RUN > ${#STATES[@]} )) && STATES_PER_RUN=${#STATES[@]}

if [[ -f "$CURSOR_FILE" ]]; then
  CURRENT_STATE="$(cat "$CURSOR_FILE" | tr -d ' \n')"
else
  CURRENT_STATE=""
fi

CURRENT_INDEX=0
if [[ -n "$CURRENT_STATE" ]]; then
  for i in "${!STATES[@]}"; do
    if [[ "${STATES[$i]}" == "$CURRENT_STATE" ]]; then
      CURRENT_INDEX="$i"
      break
    fi
  done
fi

# Select STATES_PER_RUN consecutive states starting at the cursor, wrapping
# modulo ${#STATES[@]}. STATES_PER_RUN is clamped above to at most the number
# of states, so these offsets (0..STATES_PER_RUN-1 mod length) are always
# distinct — the batch can never contain the same state twice.
BATCH_STATES=()
for (( _n = 0; _n < STATES_PER_RUN; _n++ )); do
  _idx=$(( (CURRENT_INDEX + _n) % ${#STATES[@]} ))
  BATCH_STATES+=("${STATES[$_idx]}")
done

# Cursor advance is written ONCE, before any research work below, so a crash
# mid-batch cannot make the rotation stick on the same states forever.
NEXT_INDEX=$(( (CURRENT_INDEX + STATES_PER_RUN) % ${#STATES[@]} ))
echo "${STATES[$NEXT_INDEX]}" > "$CURSOR_FILE"

log "starting discovery batch for states=${BATCH_STATES[*]} (STATES_PER_RUN=$STATES_PER_RUN)"

if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
  # Batch-mode contract, appended at the SYSTEM level so it outranks any
  # user-global ~/.claude persona (e.g. a journal rule or chatty-summary habit)
  # this headless session would otherwise inherit. On 2026-07-15 the AZ run
  # inherited that persona, ended its turn with a prose summary + journal write
  # instead of the JSON array, and the submit step then parsed zero candidates.
  # ASCII-only on purpose: launchd runs with a bare/C locale.
  BATCH_CONTRACT="You are a non-interactive batch data extractor. Your ENTIRE response MUST be exactly one raw JSON array and nothing else: no prose, no markdown fences, no preamble, no session summary, and you must NOT write any journal entry or edit any files. The final character you output must be ]."

  # macOS ships neither `timeout` nor `gtimeout`, so the old `command -v timeout`
  # check always fell through to the uncapped branch here — a run that stalled
  # (e.g. claude suspended across a sleep) then had no wall-clock cap at all.
  # Prefer whichever timeout binary exists; if none, run uncapped but say so.
  TIMEOUT_BIN=""
  if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
  fi

  # Wall-clock cap for EACH state's claude call, overridable for tests/tuning.
  # 2026-08-09 regression: historical successful runs took 420-510s against a
  # hardcoded 600s cap (Aug 6=420s, Aug 7=489s, Aug 5/8=~510s) — right at the
  # edge. It tipped over: timeout sent SIGTERM, claude emitted an
  # error_during_execution result, and the literal 15-byte string
  # "Execution error" landed in the candidates file, so candidates_file_has_array
  # below found no array and submit was silently skipped for every run since.
  # Raised well above the observed ceiling so the same margin doesn't erode again.
  DISCOVERY_TIMEOUT_SECS="${DISCOVERY_TIMEOUT_SECS:-3000}"

  # caffeinate (macOS only) prevents idle sleep from suspending the claude
  # call mid-run (see the timeout-binary comment above re: "claude suspended
  # across a sleep"). Absent on Linux/CI — CAFFEINATE_PREFIX stays an empty
  # array, a no-op. Expanded via the bash-3.2-safe "${arr[@]+"${arr[@]}"}"
  # idiom below so `set -u` never trips on an empty array on macOS's stock
  # bash 3.2 (the launchd host).
  CAFFEINATE_PREFIX=()
  if command -v caffeinate >/dev/null 2>&1; then
    CAFFEINATE_PREFIX=(caffeinate -i)
  fi

  # Explicit tool grants for the headless session. ~/.claude/settings.json only
  # allows WebFetch for github.com/raw.githubusercontent.com/api.github.com;
  # in `claude -p` there is no human to approve a permission prompt, so every
  # other WebFetch domain auto-denies. 2026-08-14 repro of the real prompt
  # produced 13 successful WebSearch calls but 3 denied WebFetch calls
  # ("Claude requested permissions to use WebFetch, but you haven't granted it
  # yet") plus a denied Read — crippling yield on a pipeline that is required
  # to cite real fetched sources. Read-only network fetch is the pipeline's
  # core need, and the same repro showed the model falling back to 14 `Bash`
  # calls shelling out to `curl` to work around the denied WebFetch — a
  # narrow `Bash(curl:*)` grant is added rather than blocking that, because
  # `curl` also reaches several bot-walled source domains (e.g. archive.org's
  # CDX API) that WebFetch cannot. NOTE this grant is NOT airtight: the
  # permission system also allows `curl -o`/`-O`, i.e. arbitrary file writes,
  # so an unattended run CAN write files despite `Write`/`Edit` being denied
  # below — this is a knowingly accepted residual risk (decided 2026-08-14),
  # accepted because curl is the only path to archive.org/CDX and thus to the
  # bot-walled sources Responsibility 4 depends on (509 counted by the
  # source-liveness check as of this decision). `Write`/`Edit`/`NotebookEdit`/
  # `Agent`/`Task` stay denied so an unattended run structurally cannot use
  # the file-editing tools directly, commit, or fan out sub-agents — the
  # prompt only asks for that in prose today. Kept as a shared array (both
  # invoke_claude branches below) so the two invocations can't drift,
  # expanded via the same bash-3.2-safe idiom as CAFFEINATE_PREFIX.
  # `Bash(curl:*)` contains a glob/parens and MUST stay a single array
  # element — never re-split this into a bare string.
  CLAUDE_TOOL_FLAGS=(--allowedTools "WebSearch WebFetch Read Glob Grep Bash(curl:*)" --disallowedTools "Write Edit NotebookEdit Agent Task")

  invoke_claude() {
    if [[ -n "$TIMEOUT_BIN" ]]; then
      "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" "$TIMEOUT_BIN" "$DISCOVERY_TIMEOUT_SECS" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null > "$OUTFILE"
    else
      log "WARN: no timeout/gtimeout binary found — running claude without a wall-clock cap"
      "${CAFFEINATE_PREFIX[@]+"${CAFFEINATE_PREFIX[@]}"}" claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" "${CLAUDE_TOOL_FLAGS[@]+"${CLAUDE_TOOL_FLAGS[@]}"}" --output-format text < /dev/null > "$OUTFILE"
    fi
  }

  # candidates_file_has_array: mirrors parseCandidatesJson's accept/reject
  # semantics exactly (raw array, or a preamble-tolerant [ .. ] slice) so a
  # legitimately empty `[]` result is never mistaken for a parse failure.
  candidates_file_has_array() {
    npx tsx -e '
import { parseCandidatesJson } from "./scripts/discovery/submit-candidates.ts";
import { readFileSync } from "node:fs";
try {
  const a = parseCandidatesJson(readFileSync(process.argv[1], "utf8"));
  process.exit(Array.isArray(a) ? 0 : 1);
} catch {
  process.exit(1);
}
' "$1" >/dev/null 2>&1
  }
fi

# --- self-reverting review cap ----------------------------------------------
# Burst: 25 candidates/day for the first BURST_DAYS days after BURST_START_DATE
# (a deliberate ~2-week catch-up while the daily review queue is fresh), then
# auto-revert to STEADY_CAP/day. No manual step to revert — the date does it.
# MAX_CANDIDATES in the environment always overrides (escape hatch / tests).
# Caps raised 2026-08-14 (10/5 -> 25/15, ~3x) once the timeout/permission fixes
# above restored real daily yield. Applied PER STATE below (a ceiling per
# submit call, not a per-batch total) — it is a ceiling, not a target;
# observed yield is ~10/state against a cap of 25, so covering multiple
# states per run does not mean e.g. 50 rows/day.
BURST_START_DATE="2026-07-30"   # date the self-reverting cap shipped
BURST_DAYS=20
BURST_CAP=25
STEADY_CAP=15

compute_cap() {
  # BSD (macOS) and GNU (Linux/CI) date differ; try BSD -j -f first, then GNU -d.
  local start_epoch now_epoch elapsed_days
  start_epoch="$(date -j -f '%Y-%m-%d' "$BURST_START_DATE" '+%s' 2>/dev/null \
    || date -d "$BURST_START_DATE" '+%s' 2>/dev/null || echo '')"
  now_epoch="$(date '+%s')"
  if [[ -z "$start_epoch" ]]; then
    # date parsing failed on this platform — fail safe to the steady cap.
    echo "$STEADY_CAP"
    return 0
  fi
  elapsed_days=$(( (now_epoch - start_epoch) / 86400 ))
  if (( elapsed_days >= 0 && elapsed_days < BURST_DAYS )); then
    echo "$BURST_CAP"
  else
    echo "$STEADY_CAP"
  fi
}

CAP="$(compute_cap)"
log "review cap for this run: --max=${MAX_CANDIDATES:-$CAP} per state (burst=${BURST_CAP}/day for ${BURST_DAYS}d from ${BURST_START_DATE}, then ${STEADY_CAP}/day) — shared across new discovery + status + enrichment"

# --- per-state loop -----------------------------------------------------
# Everything below is isolated per state: a timeout, a no-array result, or a
# failed submit for one state must not prevent the remaining states in the
# batch from running. Every command that can legitimately fail here is
# guarded with `if`/`||` (never bare) so a nonzero exit can't trip set -e and
# abort the loop early — that would defeat the entire point of processing
# multiple states per run.
RUN_IDS=()
HB_RUN_IDS=()
HB_STATES=()
HB_STATUSES=()

for STATE in "${BATCH_STATES[@]}"; do
  RUN_ID="$(date '+%Y%m%dT%H%M%S')-${STATE}"
  RUN_IDS+=("$RUN_ID")
  log "starting discovery run $RUN_ID for state=$STATE"

  # --- existing-facilities projection (fail-open: empty string on any error) --
  if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
    EXISTING_FACILITIES=""
  else
    if ! EXISTING_FACILITIES="$(npx tsx --env-file=.env.local scripts/discovery/existing-facilities.ts --state="$STATE" 2>>"$LOG_DIR/existing-facilities.err")"; then
      log "WARN: existing-facilities fetch failed for $STATE — proceeding with empty projection (see existing-facilities.err)"
      EXISTING_FACILITIES=""
    fi
  fi

  # --- discovery step (agentic, subscription — NEVER run during dev) ---------
  OUTFILE="$LOG_DIR/candidates-${RUN_ID}.json"

  CLAUDE_ARRAY_OK=false

  if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
    log "DISCOVERY_DRY_RUN=true — skipping claude call, using empty candidate set"
    if [[ ! -f "$OUTFILE" ]]; then
      echo "[]" > "$OUTFILE"
    fi
    CLAUDE_ARRAY_OK=true
  else
    log "invoking claude for state=$STATE (requires an authenticated subscription session)"
    # {{EXISTING_FACILITIES}} may contain unescaped facility name/operator/URL
    # field content (slashes, ampersands, newlines, even shell metacharacters).
    # It MUST be inserted as a literal block that is never shell-evaluated or
    # re-interpreted — a plain sed s/{{X}}/$VAR/ substitution is unsafe here.
    # Use sed's `r` (read-file) command instead: replace the placeholder LINE
    # with the verbatim contents of a temp file.
    EXISTING_FACILITIES_FILE="$(mktemp)"
    printf '%s' "$EXISTING_FACILITIES" > "$EXISTING_FACILITIES_FILE"
    PROMPT="$(sed "s/{{STATE}}/$STATE/g" "$REPO_ROOT/scripts/discovery/discovery-prompt.txt" \
      | sed "/{{EXISTING_FACILITIES}}/{
r $EXISTING_FACILITIES_FILE
d
}")"
    rm -f "$EXISTING_FACILITIES_FILE"

    # Guarded: a nonzero exit here (e.g. "You've hit your session limit") must
    # not trip set -e and kill the whole batch — the submit step below is
    # gated on CLAUDE_ARRAY_OK instead of relying on invoke_claude having
    # succeeded. Exit status 124 (GNU timeout's own timeout code) is called
    # out separately so a future wall-clock-cap regression is diagnosable
    # from launchd.out alone, without needing a live repro like the
    # 2026-08-09 incident required.
    INVOKE_STATUS=0
    invoke_claude || INVOKE_STATUS=$?
    if [[ "$INVOKE_STATUS" -eq 124 ]]; then
      log "WARN: claude invocation for $RUN_ID timed out after DISCOVERY_TIMEOUT_SECS=${DISCOVERY_TIMEOUT_SECS}s — output may be empty or an error string; submit may be skipped"
    elif [[ "$INVOKE_STATUS" -ne 0 ]]; then
      log "WARN: claude invocation for $RUN_ID exited nonzero (session limit / timeout / crash) — output may be empty or an error string; submit may be skipped"
    fi
    CLAUDE_ARRAY_OK=$(candidates_file_has_array "$OUTFILE" && echo true || echo false)

    # Bounded single retry: on 2026-07-15 the AZ run inherited the maintainer's
    # ~/.claude persona and ended its turn with a prose summary + journal write
    # instead of the JSON array — no array at all, not just malformed JSON. The
    # BATCH_CONTRACT above mitigates this but does not eliminate it, so retry
    # exactly once on a genuine no-array result, then proceed either way — the
    # submit step below skips (rather than crashes) on a still-empty/unparseable
    # OUTFILE, tracked via CLAUDE_ARRAY_OK.
    if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
      log "WARN: claude output for $RUN_ID had no parseable JSON array — retrying once"
      RETRY_STATUS=0
      invoke_claude || RETRY_STATUS=$?
      if [[ "$RETRY_STATUS" -eq 124 ]]; then
        log "WARN: retry claude invocation for $RUN_ID timed out after DISCOVERY_TIMEOUT_SECS=${DISCOVERY_TIMEOUT_SECS}s"
      elif [[ "$RETRY_STATUS" -ne 0 ]]; then
        log "WARN: retry claude invocation for $RUN_ID exited nonzero"
      fi
      CLAUDE_ARRAY_OK=$(candidates_file_has_array "$OUTFILE" && echo true || echo false)
      if [[ "$CLAUDE_ARRAY_OK" != "true" ]]; then
        log "WARN: retry for $RUN_ID still had no parseable JSON array — skipping submit"
      fi
    fi
  fi

  # --- submit step (deterministic — staging queue only) ---------------------
  # `if !` (never bare) so a nonzero submit exit for THIS state cannot trip
  # set -e and abort the remaining states in the batch.
  if [[ "$CLAUDE_ARRAY_OK" == "true" ]]; then
    log "submitting candidates from $OUTFILE"
    if ! npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$OUTFILE" \
      --run-id="$RUN_ID" \
      --max="${MAX_CANDIDATES:-$CAP}" \
      --state="$STATE" \
      ${API_BASE_URL:+--base-url="$API_BASE_URL"}; then
      log "WARN: submit-candidates failed for $RUN_ID (state=$STATE) — continuing with remaining states"
    fi
  else
    log "WARN: no parseable candidate array for $RUN_ID — skipping submit (nothing to stage)"
  fi

  if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
    HEARTBEAT_STATUS="no_array"
    [[ "$CLAUDE_ARRAY_OK" == "true" ]] && HEARTBEAT_STATUS="ok"
    HB_RUN_IDS+=("$RUN_ID")
    HB_STATES+=("$STATE")
    HB_STATUSES+=("$HEARTBEAT_STATUS")
  fi

  log "discovery run $RUN_ID complete"
done

# --- source-liveness check (read-only — runs ONCE per batch, after all
# states, including dry-run). Global, not per-state, and takes ~4 minutes —
# running it once per state would be pure waste. -----------------------------
log "checking source liveness"
if ! npx tsx --env-file=.env.local scripts/discovery/check-sources.ts 2>>"$LOG_DIR/check-sources.err"; then
  log "WARN: source-liveness check failed — continuing (see check-sources.err)"
fi

log "discovery batch complete: states=${BATCH_STATES[*]} run_ids=${RUN_IDS[*]}"

# Heartbeat: a visible "last real run" marker so a silent launchd skip/crash is
# obvious at a glance (stale lastRunAt = job not running; claudeStatus=no_array
# = the run reached claude but got a session-limit/prose reply, not candidates).
# Extended to represent the whole batch (one entry per state) so a partial
# batch — some states ok, some no_array — is visibly distinguishable from a
# clean one, while staying valid JSON.
if [[ "${DISCOVERY_DRY_RUN:-false}" != "true" ]]; then
  HEARTBEAT_ENTRIES=""
  for (( _h = 0; _h < ${#HB_STATES[@]}; _h++ )); do
    _entry="    {
      \"runId\": \"${HB_RUN_IDS[$_h]}\",
      \"state\": \"${HB_STATES[$_h]}\",
      \"claudeStatus\": \"${HB_STATUSES[$_h]}\"
    }"
    if [[ -z "$HEARTBEAT_ENTRIES" ]]; then
      HEARTBEAT_ENTRIES="$_entry"
    else
      HEARTBEAT_ENTRIES="$HEARTBEAT_ENTRIES,
$_entry"
    fi
  done
  cat >"$LOG_DIR/heartbeat.json" <<EOF
{
  "lastRunAt": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "states": [
$HEARTBEAT_ENTRIES
  ]
}
EOF
  log "wrote heartbeat -> $LOG_DIR/heartbeat.json (states=${HB_STATES[*]} statuses=${HB_STATUSES[*]})"
fi
