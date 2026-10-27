#!/usr/bin/env bats
# Coverage for scripts/discovery/fetch-url.sh (GET-only curl wrapper). HOME is
# isolated and `curl` is a PATH shim that logs argv one element per line, so
# no test ever touches the network.

setup() {
	REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
	FETCH="${FETCH_OVERRIDE:-$REPO_ROOT/scripts/discovery/fetch-url.sh}"

	TEST_TMP="$(mktemp -d)"
	HOME="$TEST_TMP/home"
	mkdir -p "$HOME" "$TEST_TMP/bin"
	CURL_LOG="$TEST_TMP/curl.log"
	export CURL_LOG
	cat >"$TEST_TMP/bin/curl" <<'SHIM'
#!/bin/bash
for a in "$@"; do printf '%s\n' "$a" >>"$CURL_LOG"; done
exit 0
SHIM
	chmod +x "$TEST_TMP/bin/curl"
	PATH="$TEST_TMP/bin:$PATH"
}

teardown() {
	rm -rf "$TEST_TMP"
}

@test "valid https URL: -q first, -- before the URL, URL last" {
	run "$FETCH" "https://example.com/a?b=1"
	[ "$status" -eq 0 ]
	[ "$(sed -n 1p "$CURL_LOG")" = "-q" ]
	[ "$(tail -n 2 "$CURL_LOG" | head -n 1)" = "--" ]
	[ "$(tail -n 1 "$CURL_LOG")" = "https://example.com/a?b=1" ]
}

@test "valid plain http URL is accepted" {
	run "$FETCH" "http://example.com/x"
	[ "$status" -eq 0 ]
	[ "$(tail -n 1 "$CURL_LOG")" = "http://example.com/x" ]
}

@test "no arguments: exit 2, curl not called" {
	run "$FETCH"
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "two arguments: exit 2, curl not called" {
	run "$FETCH" -d @/etc/passwd http://127.0.0.1/x
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "two valid URLs: exit 2, curl not called" {
	run "$FETCH" http://example.com/a http://example.com/b
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "file:// URL: exit 2, curl not called" {
	run "$FETCH" "file:///etc/passwd"
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "ftp:// URL: exit 2, curl not called" {
	run "$FETCH" "ftp://example.com/x"
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "URL containing a space: exit 2, curl not called" {
	run "$FETCH" "https://example.com/a b"
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "URL containing a newline: exit 2, curl not called" {
	run "$FETCH" $'https://example.com/a\nb'
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "option-looking argument (--config=...) fails the http(s) prefix check: exit 2, curl not called" {
	run "$FETCH" "--config=/tmp/x"
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "accepted URL: argv contains no upload/config/output flags" {
	run "$FETCH" "https://example.com/x"
	[ "$status" -eq 0 ]
	for flag in -d -F -T -K -o -H --data --data-binary --upload-file --config; do
		[ "$(grep -cxF -- "$flag" "$CURL_LOG")" -eq 0 ]
	done
}

@test "accepted URL: pinned protocol, redirect and glob flags" {
	run "$FETCH" "https://example.com/x"
	[ "$status" -eq 0 ]
	grep -qxF -- "-g" "$CURL_LOG"
	[ "$(grep -xF -A1 -- "--proto" "$CURL_LOG" | sed -n 2p)" = "=http,https" ]
	[ "$(grep -xF -A1 -- "--proto-redir" "$CURL_LOG" | sed -n 2p)" = "=http,https" ]
	[ "$(grep -xF -A1 -- "--max-redirs" "$CURL_LOG" | sed -n 2p)" = "10" ]
}

@test "URL containing a control character (SOH): exit 2, curl not called" {
	run "$FETCH" $'https://example.com/a\x01b'
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "URL containing DEL: exit 2, curl not called" {
	run "$FETCH" $'https://example.com/a\x7fb'
	[ "$status" -eq 2 ]
	[ ! -e "$CURL_LOG" ]
}

@test "@ inside a path is accepted" {
	run "$FETCH" "https://medium.com/@someone/post"
	[ "$status" -eq 0 ]
	[ "$(tail -n 1 "$CURL_LOG")" = "https://medium.com/@someone/post" ]
}
