#!/usr/bin/env bash
# Classifies whether the JSON<->Neon sync is CONVERGING, STUCK, or ABSENT so
# that drift-alert.yml can suppress its alert while a sync is genuinely
# mid-flight instead of racing it.
#
# Why this exists: on 2026-09-12, neon-sync.yml was dispatched at 23:16:57Z,
# opened PR #295 at 23:41:09Z, and drift-alert.yml ran at 23:44:38Z — inside
# the 6.5-minute window before a human merged the PR at 23:47:46Z. The
# workflow saw drift, had no notion of "converging right now", and filed
# issue #297 for a race, not a real problem. This script is the classifier
# the workflow calls to tell the two apart.
#
# Usage:
#   classify-sync-convergence.sh --now <epoch-seconds> --grace <seconds> \
#                                 --prs <file.json> --runs <file.json>
#
#   --prs   path to a JSON array from:
#             gh pr list --head automated/neon-sync --state open \
#               --json number,createdAt,url
#           ([] when none)
#   --runs  path to a JSON array from:
#             gh run list --workflow=neon-sync.yml \
#               --status in_progress --status queued \
#               --json databaseId,status
#           ([] when none)
#
# Rules, in order:
#   1. any element in --runs                          -> converging
#   2. else an open PR younger than --grace seconds    -> converging
#   3. else an open PR at least --grace seconds old     -> stuck
#   4. else                                             -> absent
#
# Prints exactly one word to stdout and exits 0 on success:
#   converging | stuck | absent
#
# FAIL-LOUD CONTRACT: `converging` is the only classification that
# suppresses the alert, so this script must NEVER let a bug reach
# `converging` silently. Every validation failure below exits non-zero with
# a `::error::` message on stderr and prints nothing on stdout. "Required"
# means CHECKED here — a flag merely documented as required but never
# verified has fail-opened four different ways in this repo before
# (see compute-atlas-required-flag-is-not-a-checked-flag).
#
# Timestamp math uses jq's fromdateiso8601 deliberately, NOT the `date`
# command — BSD date (macOS, where this is authored) and GNU date (Ubuntu,
# where CI runs) parse ISO-8601 differently, and this script must behave
# identically on both.

set -euo pipefail

_err() {
	echo "::error::classify-sync-convergence.sh: $1" >&2
}

NOW=""
GRACE=""
PRS_FILE=""
RUNS_FILE=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	--now)
		NOW="${2:-}"
		shift 2
		;;
	--grace)
		GRACE="${2:-}"
		shift 2
		;;
	--prs)
		PRS_FILE="${2:-}"
		shift 2
		;;
	--runs)
		RUNS_FILE="${2:-}"
		shift 2
		;;
	*)
		_err "unknown flag: '$1'"
		exit 1
		;;
	esac
done

# --- Required-flag validation: presence ------------------------------------
if [[ -z "${NOW}" ]]; then
	_err "missing or empty --now"
	exit 1
fi
if [[ -z "${GRACE}" ]]; then
	_err "missing or empty --grace"
	exit 1
fi
if [[ -z "${PRS_FILE}" ]]; then
	_err "missing or empty --prs"
	exit 1
fi
if [[ -z "${RUNS_FILE}" ]]; then
	_err "missing or empty --runs"
	exit 1
fi

# --- Numeric validation ------------------------------------------------------
if ! [[ "${NOW}" =~ ^[0-9]+$ ]]; then
	_err "--now must be a positive integer (got: '${NOW}')"
	exit 1
fi
if ! [[ "${GRACE}" =~ ^[0-9]+$ ]]; then
	_err "--grace must be a positive integer (got: '${GRACE}')"
	exit 1
fi
if [[ "${NOW}" -eq 0 ]]; then
	_err "--now must be a positive integer (got: '${NOW}')"
	exit 1
fi
if [[ "${GRACE}" -eq 0 ]]; then
	_err "--grace must be a positive integer (got: '${GRACE}')"
	exit 1
fi

# --- File validation: exists, non-empty, valid JSON array -------------------
for LABEL_FILE in "prs:${PRS_FILE}" "runs:${RUNS_FILE}"; do
	LABEL="${LABEL_FILE%%:*}"
	FILE="${LABEL_FILE#*:}"

	if [[ ! -f "${FILE}" ]]; then
		_err "--${LABEL} file does not exist: '${FILE}'"
		exit 1
	fi
	if [[ ! -s "${FILE}" ]]; then
		_err "--${LABEL} file is empty: '${FILE}'"
		exit 1
	fi
	if ! jq -e . "${FILE}" >/dev/null 2>&1; then
		_err "--${LABEL} file is not valid JSON: '${FILE}'"
		exit 1
	fi
	if ! jq -e 'type == "array"' "${FILE}" >/dev/null 2>&1; then
		_err "--${LABEL} file is not a JSON array: '${FILE}'"
		exit 1
	fi

	# --- Element-shape validation ---------------------------------------------
	# An array-of-garbage still passes every check above (it IS a JSON array).
	# Rule 1 below fires on "any element in --runs", so an unvalidated garbage
	# element reads as converging — the one classification that suppresses the
	# alert. Reject anything that isn't the documented `gh` shape; never skip a
	# bad element and classify on what remains, which is the same fail-open
	# wearing a different hat (a wholly-garbage array would then silently read
	# as absent, a partially-garbage one as converging).
	if [[ "${LABEL}" == "runs" ]]; then
		if ! jq -e 'all(.[]; type == "object" and has("databaseId") and (.databaseId | type == "number") and has("status") and (.status | type == "string"))' "${FILE}" >/dev/null 2>&1; then
			_err "--runs file has an element that is not an object with a numeric databaseId and a string status: '${FILE}'"
			exit 1
		fi
	fi
	if [[ "${LABEL}" == "prs" ]]; then
		if ! jq -e 'all(.[]; type == "object" and has("number") and (.number | type == "number") and has("createdAt") and (.createdAt | type == "string") and ((.createdAt | try fromdateiso8601 catch null) != null) and has("url") and (.url | type == "string"))' "${FILE}" >/dev/null 2>&1; then
			_err "--prs file has an element that is not an object with a numeric number, a parseable ISO-8601 createdAt string, and a string url: '${FILE}'"
			exit 1
		fi
	fi
done

# --- Rule 1: any in-flight run -> converging --------------------------------
RUN_COUNT="$(jq 'length' "${RUNS_FILE}")"
if [[ "${RUN_COUNT}" -gt 0 ]]; then
	echo "converging"
	exit 0
fi

# --- No open PR -> absent ----------------------------------------------------
PR_COUNT="$(jq 'length' "${PRS_FILE}")"
if [[ "${PR_COUNT}" -eq 0 ]]; then
	echo "absent"
	exit 0
fi

# --- Rules 2/3: age the oldest open PR's createdAt against --grace ---------
# Multiple open PRs would be unusual (neon-sync opens at most one at a
# time), but if it ever happens, the OLDEST createdAt is the conservative
# choice: it can only push a still-converging PR toward `stuck`, never the
# reverse, so a rule-1-style false "converging" cannot slip in here.
OLDEST_CREATED_AT="$(jq -r 'map(.createdAt) | min' "${PRS_FILE}")"

if [[ "${OLDEST_CREATED_AT}" == "null" || -z "${OLDEST_CREATED_AT}" ]]; then
	_err "--prs file has an open PR with a missing createdAt"
	exit 1
fi

CREATED_EPOCH="$(jq -rn --arg ts "${OLDEST_CREATED_AT}" \
	'try ($ts | fromdateiso8601) catch "PARSE_ERROR"' 2>/dev/null || echo "PARSE_ERROR")"

if [[ "${CREATED_EPOCH}" == "PARSE_ERROR" || "${CREATED_EPOCH}" == "null" || -z "${CREATED_EPOCH}" ]]; then
	_err "could not parse createdAt as ISO-8601: '${OLDEST_CREATED_AT}'"
	exit 1
fi
if ! [[ "${CREATED_EPOCH}" =~ ^[0-9]+$ ]]; then
	_err "could not parse createdAt as ISO-8601: '${OLDEST_CREATED_AT}'"
	exit 1
fi

AGE=$((NOW - CREATED_EPOCH))

if [[ "${AGE}" -lt 0 ]]; then
	_err "createdAt is in the future relative to --now ('${OLDEST_CREATED_AT}' vs epoch ${NOW})"
	exit 1
fi

if [[ "${AGE}" -lt "${GRACE}" ]]; then
	echo "converging"
	exit 0
fi

echo "stuck"
exit 0
