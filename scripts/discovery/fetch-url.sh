#!/usr/bin/env bash
# GET-only URL fetcher for the unattended discovery `claude -p` session.
#
# The session is allowlisted this wrapper instead of raw `curl`: measured on
# 2026-10-27 (CLI 2.1.308), an allowlisted `curl -d @/abs/outside/file` and
# `curl -F f=@/abs/outside/file` both uploaded a file from outside the working
# directory even under --restricted, so raw curl is an exfiltration path for
# .env.local. This accepts exactly one http(s) URL and no curl options.

if [[ $# -ne 1 ]]; then
	echo "fetch-url: exactly one URL argument" >&2
	exit 2
fi

url="$1"
if [[ ! "$url" =~ ^https?:// ]] || [[ "$url" =~ [[:space:][:cntrl:]] ]]; then
	echo "fetch-url: only a single http(s) URL is allowed" >&2
	exit 2
fi

set -euo pipefail

# Every hop (redirects included) is vetted and DNS-pinned in fetch-url.ts: no
# private/loopback/link-local/metadata addresses. Run the repo's tsx directly
# (no npx lookup) so a minimal launchd PATH only needs `node`.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
tsx="$repo/node_modules/.bin/tsx"
if [[ ! -x "$tsx" ]]; then
	echo "fetch-url: $tsx not found (run npm ci)" >&2
	exit 1
fi
exec "$tsx" "$here/fetch-url.ts" "$url"
