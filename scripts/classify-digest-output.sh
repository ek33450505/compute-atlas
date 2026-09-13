#!/usr/bin/env bash
# Classifies the exit code and output of `check-digest-status.ts` into exactly
# one of three states: healthy | crashed | detector-broken.
#
# Why three states, and why the rule order differs from classify-drift-output.sh:
# check-neon-drift.ts ALWAYS exits 0 (even when it couldn't check anything), so
# THAT classifier can treat "any non-zero exit" as an unambiguous "the detector
# never ran" signal and check it first. check-digest-status.ts does NOT have
# that contract — it explicitly exits 1 on TWO distinct conditions: a real
# crash (an incomplete digest run was found) and a detector failure (DB
# unreachable, query error). Both conditions produce exit 1, so exit code
# alone cannot tell them apart; this classifier must inspect the OUTPUT
# message first, and only fall back to the exit code once the known messages
# are ruled out.
#
# States:
#   - healthy: table does not exist (feature not deployed), is empty (never run),
#     or all runs completed. Exit code 0 is required.
#   - crashed: one or more digest runs have completedAt IS NULL. Exit code 1
#     is required; the error line is the signal.
#   - detector-broken: the detector could not run (exit non-zero, table query
#     failed, DATABASE_URL unset, or Neon unreachable). Exit code 1 is required,
#     but the nature of the failure is different from "digest crashed".
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
# Prints exactly one word to stdout: healthy | crashed | detector-broken
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

# Rule 1: detector found an incomplete run (a real crash). Check this FIRST,
# before the general exit-code rule below, so a crash (which exits 1) is
# classified as "crashed" and not swallowed by the non-zero-exit fallback.
if [[ "${OUTPUT}" == *"incomplete state digest run(s) found"* ]]; then
	echo "crashed"
	exit 0
fi

# Rule 2: DATABASE_URL missing — detector failed to initialize.
if [[ "${OUTPUT}" == *"DATABASE_URL is not set"* ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 3: detector caught an internal error (e.g. Neon unreachable, query failed).
if [[ "${OUTPUT}" == *"Failed to query state_digest_runs"* ]] || [[ "${OUTPUT}" == *"digest status check errored"* ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 4: non-zero exit with no recognized error message — something else
# broke (e.g. the node process itself crashed before the detector's own
# logic ran). This is the "unexpected" catch-all, so it stays after the
# specific message checks above rather than short-circuiting them.
if [[ "${EXIT_CODE_ARG}" -ne 0 ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 5: exit 0, detector ran, no crash or error message — all healthy (table
# absent, empty, or all runs complete).
echo "healthy"
exit 0
