#!/usr/bin/env bash
# Verifies every record in tests/fixtures/*.fixture.json is deep-equal to its
# counterpart at the source commit (fixtures must be public, unmodified data).
set -euo pipefail

SRC_COMMIT="86fef0c"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

# check <fixture path> <source path at commit> <kind: array-id | array-operator | object>
check() {
  local fixture="$1" source="$2" kind="$3"
  if ! git show "${SRC_COMMIT}:${source}" > "$tmp/src.json"; then
    echo "FAIL: cannot read ${source} at ${SRC_COMMIT}" >&2
    fail=1
    return
  fi
  if ! node -e "$RECORDS_JS" "$tmp/src.json" "$fixture" "$kind"; then
    fail=1
  fi
}

RECORDS_JS="$(cat <<'NODE'
const fs = require("node:fs");
const assert = require("node:assert");
const [srcPath, fixturePath, kind] = process.argv.slice(1);
const source = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const keyOf = { "array-id": (r) => r.id, "array-operator": (r) => r.operator };
let srcMap;
let fixMap;
if (kind === "object") {
  srcMap = new Map(Object.entries(source));
  fixMap = new Map(Object.entries(fixture));
} else {
  srcMap = new Map(source.map((r) => [keyOf[kind](r), r]));
  fixMap = new Map(fixture.map((r) => [keyOf[kind](r), r]));
}
let bad = 0;
for (const [key, rec] of fixMap) {
  if (!srcMap.has(key)) {
    console.error(`FAIL: ${fixturePath}: unknown key "${key}"`);
    bad++;
    continue;
  }
  try {
    assert.deepStrictEqual(rec, srcMap.get(key));
  } catch {
    console.error(`FAIL: ${fixturePath}: record "${key}" differs from source`);
    bad++;
  }
}
process.exit(bad === 0 ? 0 : 1);
NODE
)"

check tests/fixtures/facilities.fixture.json data/facilities.json array-id
check tests/fixtures/siting-context.fixture.json data/siting-context.json object
check tests/fixtures/operator-ownership.fixture.json data/operator-ownership.json array-operator

# Meta: same keys as the source, recordCount must equal the fixture length.
META_JS="$(cat <<'NODE'
const fs = require("node:fs");
const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const meta = JSON.parse(fs.readFileSync("tests/fixtures/facilities.meta.fixture.json", "utf8"));
const fixtures = JSON.parse(fs.readFileSync("tests/fixtures/facilities.fixture.json", "utf8"));
let bad = 0;
if (JSON.stringify(Object.keys(meta).sort()) !== JSON.stringify(Object.keys(src).sort())) {
  console.error("FAIL: meta fixture keys differ from source");
  bad++;
}
for (const k of ["asOf", "schemaVersion", "sourceRelease"]) {
  if (meta[k] !== src[k]) {
    console.error(`FAIL: meta fixture ${k} differs from source`);
    bad++;
  }
}
if (meta.recordCount !== fixtures.length) {
  console.error(`FAIL: meta recordCount ${meta.recordCount} != fixture length ${fixtures.length}`);
  bad++;
}
process.exit(bad === 0 ? 0 : 1);
NODE
)"

if ! git show "${SRC_COMMIT}:data/facilities.meta.json" > "$tmp/meta.json"; then
  echo "FAIL: cannot read data/facilities.meta.json at ${SRC_COMMIT}" >&2
  fail=1
elif ! node -e "$META_JS" "$tmp/meta.json"; then
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi
echo "OK: all fixtures match ${SRC_COMMIT}"
