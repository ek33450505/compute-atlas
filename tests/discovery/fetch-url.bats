#!/usr/bin/env bats
# Coverage for scripts/discovery/fetch-url.sh (GET-only fetch wrapper). HOME is
# isolated and `curl` is a PATH shim that must never run. Every URL here is
# refused before any connection, so no test touches the network; the allowed
# path and the redirect/DNS guards are covered in fetch-url.test.ts with an
# injected fetch and resolver (the CLI has no seam to relax the guard).

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

# The private-address guard: refused (exit 2) before any connection.
@test "private/loopback/metadata/localhost literals are refused with a reason" {
	for u in http://127.0.0.1:11434/ "http://[::1]/" http://169.254.169.254/latest/meta-data/ \
		http://10.0.0.1/ http://192.168.1.1/ http://100.64.0.1/ http://localhost/ \
		"http://[::ffff:127.0.0.1]/" http://0x7f.1/; do
		run "$FETCH" "$u"
		[ "$status" -eq 2 ]
		[[ "$output" == *"refused"* ]]
	done
	[ ! -e "$CURL_LOG" ]
}

@test "fullwidth, percent-encoded and userinfo authorities are refused" {
	# UTF-8 bytes via octal printf escapes: a $'...' literal is not expanded under bats + bash 3.2
	local fw
	fw="$(printf 'http://\357\274\221\357\274\222\357\274\227.0.0.1/')"
	run "$FETCH" "$fw"
	[ "$status" -eq 2 ]
	[[ "$output" == *"non-ASCII authority"* ]]
	for u in "$fw" "http://127%2E0.0.1/" "http://%6c%6f%63alhost/" \
		"http://example.com@127.0.0.1/" "http://127.0.0.1%40example.com/"; do
		run "$FETCH" "$u"
		[ "$status" -eq 2 ]
		[[ "$output" == *"refused"* ]]
	done
}

@test "@ inside a path is not mistaken for userinfo (guard refuses the loopback host)" {
	run "$FETCH" "http://127.0.0.1/@someone/post"
	[ "$status" -eq 2 ]
	[[ "$output" == *"blocked host"* ]]
}
