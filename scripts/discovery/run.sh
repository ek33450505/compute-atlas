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

STATE="${STATES[$CURRENT_INDEX]}"

# --- existing-facilities projection (fail-open: empty string on any error) --
if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
  EXISTING_FACILITIES=""
else
  if ! EXISTING_FACILITIES="$(npx tsx --env-file=.env.local scripts/discovery/existing-facilities.ts --state="$STATE" 2>>"$LOG_DIR/existing-facilities.err")"; then
    log "WARN: existing-facilities fetch failed for $STATE — proceeding with empty projection (see existing-facilities.err)"
    EXISTING_FACILITIES=""
  fi
fi

NEXT_INDEX=$(( (CURRENT_INDEX + 1) % ${#STATES[@]} ))
echo "${STATES[$NEXT_INDEX]}" > "$CURSOR_FILE"

RUN_ID="$(date '+%Y%m%dT%H%M%S')-${STATE}"
log "starting discovery run $RUN_ID for state=$STATE"

# --- discovery step (agentic, subscription — NEVER run during dev) ---------
OUTFILE="$LOG_DIR/candidates-${RUN_ID}.json"

if [[ "${DISCOVERY_DRY_RUN:-false}" == "true" ]]; then
  log "DISCOVERY_DRY_RUN=true — skipping claude call, using empty candidate set"
  if [[ ! -f "$OUTFILE" ]]; then
    echo "[]" > "$OUTFILE"
  fi
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

  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" 600 claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" --output-format text < /dev/null > "$OUTFILE"
  else
    log "WARN: no timeout/gtimeout binary found — running claude without a wall-clock cap"
    claude -p "$PROMPT" --append-system-prompt "$BATCH_CONTRACT" --output-format text < /dev/null > "$OUTFILE"
  fi
fi

# --- submit step (deterministic — staging queue only) -----------------------
log "submitting candidates from $OUTFILE"
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$OUTFILE" \
  --run-id="$RUN_ID" \
  --max="${MAX_CANDIDATES:-5}" \
  --state="$STATE" \
  ${API_BASE_URL:+--base-url="$API_BASE_URL"}

# --- source-liveness check (read-only — runs every run, including dry-run) --
log "checking source liveness"
npx tsx --env-file=.env.local scripts/discovery/check-sources.ts 2>>"$LOG_DIR/check-sources.err" || true

log "discovery run $RUN_ID complete"
