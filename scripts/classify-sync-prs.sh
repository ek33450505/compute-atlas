#!/usr/bin/env bash
# classify-sync-prs.sh - decide whether a job should defer to an open neon-sync PR.
#
# stdin : a JSON array with one object per open PR, each carrying
#           number            integer
#           isCrossRepository boolean (true = opened from a fork)
#           createdAt         "YYYY-MM-DDTHH:MM:SSZ"
#         nhd-backfill.yml builds it from the owner-namespaced pulls query
#           gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100&head=$OWNER:automated/neon-sync"
# $1    : optional "now" as epoch seconds (default: current time). Tests pass a
#         fixed value so the age maths is deterministic.
#
# Prints exactly one line and exits 0:
#   proceed                       no same-repo PR is open
#   defer <count>                 every same-repo PR is <= 24h old
#   stale <#n (Hh)>[, <#n (Hh)>]  at least one same-repo PR is > 24h old
# Exits 2 with a message on stderr for anything it cannot classify (empty or
# non-array JSON, a non-boolean/missing isCrossRepository on ANY entry, a
# same-repo PR whose number is not an integer or whose createdAt is not exactly
# the timestamp shape above, a bad "now"), so the caller fails closed instead
# of guessing.
#
# The number and createdAt checks are what keep the output to ONE line: the
# caller echoes it into a GitHub Actions log, where a newline followed by
# "::error::..." would be read as a workflow command. createdAt is matched with
# \z, not $, because Oniguruma's $ also matches before a trailing newline, and
# jq 1.7's fromdateiso8601 silently accepts text after a newline.
#
# Cross-repository (fork) PRs are dropped as soon as isCrossRepository is
# confirmed boolean, and none of their other fields are read. The caller's
# query should not return forks at all; this is defence in depth.
#
# Time maths is jq's fromdateiso8601 (portable); GNU-only `date -d` is avoided
# so the script behaves the same on macOS and on the runner.
set -euo pipefail

STALE_AFTER_SECONDS=86400

fail() {
	echo "classify-sync-prs: $1" >&2
	exit 2
}

command -v jq >/dev/null 2>&1 || fail "jq is required"

now="${1:-$(date -u +%s)}"
[[ "$now" =~ ^[0-9]+$ ]] || fail "now must be epoch seconds, got: $now"

decision="$(
	jq -rs --argjson now "$now" --argjson limit "$STALE_AFTER_SECONDS" '
    if length != 1 then error("expected exactly one JSON document") else .[0] end
    | if type != "array" then error("expected a JSON array") else . end
    | map(if (.isCrossRepository | type) == "boolean" then . else error("isCrossRepository must be a boolean") end)
    | map(select(.isCrossRepository == false))
    | map(
        if ((.number | type) == "number") and (.number == (.number | floor)) then . else error("number must be an integer") end
        | if ((.createdAt | type) == "string") and (.createdAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\\z")) then . else error("createdAt must be YYYY-MM-DDTHH:MM:SSZ") end
        | {number, age: ($now - (.createdAt | fromdateiso8601))}
      )
    | map(select(.age > $limit)) as $stale
    | if length == 0 then "proceed"
      elif ($stale | length) > 0 then
        "stale " + ($stale | map("#\(.number) (\(.age / 3600 | floor)h)") | join(", "))
      else "defer \(length)"
      end
  '
)" || fail "invalid input (see jq error above)"

[[ -n "$decision" ]] || fail "no decision produced"
echo "$decision"
