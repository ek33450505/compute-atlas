#!/usr/bin/env bash
# Classifies the combined stdout+stderr of `scripts/check-neon-drift.ts` into
# exactly one of three states: converged | drifted | detector-broken.
#
# Why three states, not two: check-neon-drift.ts is written to ALWAYS exit 0
# (three `process.exit(0)` paths) — even when it could not verify anything
# (no DATABASE_URL, Neon unreachable, etc). That means a plain "did it print
# a drift message" grep cannot distinguish "no drift" from "never ran at
# all", which is exactly the bug that made drift-alert.yml report "drift
# present" on 6 consecutive nightly runs (2026-09-03..2026-09-08) whose real
# cause was an `--env-file=.env.local` flag that doesn't exist on the runner
# (node exits 9 before the detector's own logic ever executes).
#
# That non-zero-exit case is the reliable signal this script leans on: since
# the detector's OWN code never exits non-zero, seeing a non-zero exit code
# here means something outside the detector's control (node itself, the
# shell invocation) failed before detection could happen — so rule 1 below
# is unambiguous, not just the highest-priority guess.
#
# Grep patterns deliberately omit the leading "✓ " glyph on the converged
# message so every pattern in this file stays plain ASCII.
#
# Usage — capture rc the INSTANT the command returns, then pipe:
#
#   set +e
#   OUTPUT="$(npx tsx scripts/check-neon-drift.ts 2>&1)"
#   rc=$?
#   set -e
#   printf '%s\n' "$OUTPUT" | classify-drift-output.sh "$rc"
#
# WARNING: do NOT write `some-command 2>&1 | classify-drift-output.sh "$?"`.
# The shell expands "$?" while SETTING UP the pipeline, so it carries the
# status of whatever ran BEFORE the pipeline, never some-command's. Verified
# 2026-09-09: with that form, a detector crashing with exit 9 classifies as
# `drifted` — reproducing the precise misdiagnosis this script exists to
# prevent. This is the same family as the `tee` trap in CLAUDE.md: anything
# wrapping a command can silently replace the exit status you meant to read.
#
# Prints exactly one word to stdout: converged | drifted | detector-broken
# Always exits 0 — this script classifies, it does not gate.

set -euo pipefail

EXIT_CODE_ARG="${1:-}"

OUTPUT="$(cat)"

# Fail-closed: a missing or non-numeric exit-code argument must never read
# as "converged". Treat it as detector-broken and say why on stderr.
if [[ -z "${EXIT_CODE_ARG}" ]] || ! [[ "${EXIT_CODE_ARG}" =~ ^[0-9]+$ ]]; then
	echo "classify-drift-output.sh: missing or non-numeric exit-code argument (got: '${EXIT_CODE_ARG}')" >&2
	echo "detector-broken"
	exit 0
fi

# Rule 1: any non-zero exit means the detector's own always-exit-0 contract
# was never reached — something failed before detection could happen.
if [[ "${EXIT_CODE_ARG}" -ne 0 ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 2: DATABASE_URL missing — detector skipped by design, not "no drift".
if [[ "${OUTPUT}" == *"DATABASE_URL not configured"* ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 3: detector caught an internal error (e.g. Neon unreachable) and
# reported it via its non-blocking ::notice:: path.
if [[ "${OUTPUT}" == *"drift check errored"* ]]; then
	echo "detector-broken"
	exit 0
fi

# Rule 4: the detector's explicit converged message.
if [[ "${OUTPUT}" == *"No drift detected between JSON and Neon"* ]]; then
	echo "converged"
	exit 0
fi

# Rule 5: exit 0, detector ran, no converged message — real drift.
echo "drifted"
exit 0
