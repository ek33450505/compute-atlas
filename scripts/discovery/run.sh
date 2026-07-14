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
  PROMPT="$(sed "s/{{STATE}}/$STATE/g" "$REPO_ROOT/scripts/discovery/discovery-prompt.txt")"
  if command -v timeout >/dev/null 2>&1; then
    timeout 600 claude -p "$PROMPT" --output-format text < /dev/null > "$OUTFILE"
  else
    claude -p "$PROMPT" --output-format text < /dev/null > "$OUTFILE"
  fi
fi

# --- submit step (deterministic — staging queue only) -----------------------
log "submitting candidates from $OUTFILE"
npx tsx --env-file=.env.local scripts/discovery/submit-candidates.ts "$OUTFILE" \
  --run-id="$RUN_ID" \
  --max="${MAX_CANDIDATES:-5}" \
  --state="$STATE" \
  ${API_BASE_URL:+--base-url="$API_BASE_URL"}

log "discovery run $RUN_ID complete"
