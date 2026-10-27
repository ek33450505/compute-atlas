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

# -q must stay first: it is what disables ~/.curlrc.
exec curl -q -sS -L -g \
	--proto '=http,https' --proto-redir '=http,https' \
	--max-redirs 10 --max-time 60 --max-filesize 52428800 \
	-A 'ComputeAtlas-discovery/1.0 (+https://www.compute-atlas.com)' \
	-- "$url"
