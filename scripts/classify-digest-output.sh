#!/usr/bin/env bash
# Classifies the exit code and output of `check-digest-status.ts` into exactly
# the states listed below (healthy, or one or more failure states).
#
# Why these states, and why the rule order checks output before exit code:
# a classifier for a detector that always exits 0 could treat "any non-zero
# exit" as an unambiguous "the detector never ran" signal and check it first.
# check-digest-status.ts does NOT have that contract — it explicitly exits 1 on TWO
# distinct conditions: a real
# crash (an incomplete digest run was found) and a detector failure (DB
# unreachable, query error). Both conditions produce exit 1, so exit code
# alone cannot tell them apart; this classifier must inspect the OUTPUT
# message first, and only fall back to the exit code once the known messages
# are ruled out.
#
# States (one or more may be printed, see "Output" below):
#   - healthy: table does not exist (feature not deployed), is empty (never run),
#     all runs completed, or only `::warning::` lines were printed (e.g. send
#     failures in a run older than 7 days). Exit code 0 is required.
#   - crashed: one or more digest runs have completedAt IS NULL. The error line
#     is the signal.
#   - send-failures: an `::error::` line says digest recipient(s) in a recent run
#     were not mailed. The same text on a `::warning::` line does NOT count.
#   - recipient-alarm: an `::error::` line says confirmed digest subscriptions
#     exceed the alarm.
#   - detector-broken: the detector could not run (DATABASE_URL unset, a query
#     failed, the check errored), printed an `::error::` line no other rule
#     recognises, printed nothing at all, or exited non-zero with output that
#     matches no known failure. This is the fail-closed catch-all.
#
# Output: check-digest-status.ts runs ALL its checks and prints every failure, so
# one output can hold several failure kinds (e.g. a crash AND send failures).
# This script therefore prints every matching state, space-separated, in the
# fixed order: crashed send-failures recipient-alarm detector-broken. `healthy`
# is only ever printed alone. The workflow must test each token (for example
# `contains(steps.digest.outputs.state, 'crashed')`), never `==` on a combined
# value, and keep a catch-all for a value containing no known token.
#
# Usage — capture rc the INSTANT the command returns, then pipe:
#
#   set +e
#   OUTPUT="$(npx tsx scripts/discovery/check-digest-status.ts 2>&1)"
#   rc=$?
#   set -e
#   printf '%s\n' "$OUTPUT" | classify-digest-output.sh "$rc"
#
# WARNING: do NOT write `some-command 2>&1 | classify-digest-output.sh "$?"`.
# The shell expands "$?" while SETTING UP the pipeline, so it carries the
# status of whatever ran BEFORE the pipeline. This is the same family as the
# `tee` trap in CLAUDE.md: anything wrapping a command can silently replace
# the exit status you meant to read.
#
# Prints to stdout: healthy, or one or more of the failure states above.
# Always exits 0 — this script classifies, it does not gate.

set -euo pipefail

EXIT_CODE_ARG="${1:-}"

OUTPUT="$(cat)"

# Fail-closed: a missing or non-numeric exit-code argument must never read
# as "healthy". Treat it as detector-broken and say why on stderr.
if [[ -z "${EXIT_CODE_ARG}" ]] || ! [[ "${EXIT_CODE_ARG}" =~ ^[0-9]+$ ]]; then
	echo "classify-digest-output.sh: missing or non-numeric exit-code argument (got: '${EXIT_CODE_ARG}')" >&2
	echo "detector-broken"
	exit 0
fi

STATES=()
DETECTOR_BROKEN=0

# Anchored to the `::error::` annotation so the `::warning::` form of the
# send-failure line (run older than 7 days, exit 0) stays healthy.
has_error_line() {
	grep -qE "^::error::.*$1" <<<"${OUTPUT}"
}

# Incomplete run (a real crash). Matched on the message, not the exit code: a
# crash and a detector failure both exit 1.
if [[ "${OUTPUT}" == *"incomplete state digest run(s) found"* ]]; then
	STATES+=("crashed")
fi

if has_error_line "digest recipient\\(s\\) in run \\["; then
	STATES+=("send-failures")
fi

if has_error_line "confirmed digest subscriptions exceed the alarm"; then
	STATES+=("recipient-alarm")
fi

# Detector failed to initialise or caught an internal error (Neon unreachable,
# query failed).
if [[ "${OUTPUT}" == *"DATABASE_URL is not set"* ]] ||
	[[ "${OUTPUT}" == *"Failed to query state_digest_runs"* ]] ||
	[[ "${OUTPUT}" == *"Failed to query digest sends"* ]] ||
	[[ "${OUTPUT}" == *"digest status check errored"* ]]; then
	DETECTOR_BROKEN=1
fi

# Any `::error::` line that no rule above recognises (e.g. "Failed to count
# digest subscriptions") must not be dropped when another state is present.
while IFS= read -r line; do
	[[ "${line}" == "::error::"* ]] || continue
	case "${line}" in
	*"incomplete state digest run(s) found"* | \
		*"digest recipient(s) in run ["* | \
		*"confirmed digest subscriptions exceed the alarm"* | \
		*"DATABASE_URL is not set"* | \
		*"Failed to query state_digest_runs"* | \
		*"Failed to query digest sends"* | \
		*"digest status check errored"*) ;;
	*) DETECTOR_BROKEN=1 ;;
	esac
done <<<"${OUTPUT}"

# Empty output: a clean run always prints at least one note, so silence means
# the detector never reported. Fail closed regardless of the exit code.
if [[ -z "${OUTPUT//[[:space:]]/}" ]]; then
	DETECTOR_BROKEN=1
fi

# Fallback, last: non-zero exit that no rule above explains (e.g. the node
# process died before the detector's own logic ran).
if [[ ${#STATES[@]} -eq 0 && "${EXIT_CODE_ARG}" -ne 0 ]]; then
	DETECTOR_BROKEN=1
fi

if [[ "${DETECTOR_BROKEN}" -eq 1 ]]; then
	STATES+=("detector-broken")
fi

if [[ ${#STATES[@]} -eq 0 ]]; then
	echo "healthy"
else
	echo "${STATES[*]}"
fi
exit 0
