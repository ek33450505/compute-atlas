import { canonicalStringify } from "./canonical-json";
import type { Facility } from "./schema";

const NARRATION_KEYS = new Set(["notes", "note"]);

function isText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * Walks both docs in parallel and drops every `notes` / `note` key whose value
 * is text (string, null or absent) on BOTH sides. A structured value (object,
 * array, number, boolean) on either side is kept and compared like any other
 * field, so a structural change can never be hidden as editorial.
 */
function stripPair(a: unknown, b: unknown): [unknown, unknown] {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const pairs = a.map((item, i) => stripPair(item, b[i]));
    return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
  }
  if (
    a !== null && b !== null &&
    typeof a === "object" && typeof b === "object" &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const outA: Record<string, unknown> = {};
    const outB: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (NARRATION_KEYS.has(key) && isText(left[key]) && isText(right[key])) continue;
      const [x, y] = stripPair(left[key], right[key]);
      if (key in left) outA[key] = x;
      if (key in right) outB[key] = y;
    }
    return [outA, outB];
  }
  return [a, b];
}

/**
 * True iff `before` and `after` differ ONLY in free-text narration: `notes` /
 * `note` keys, at any depth, holding text on both sides. Anything else
 * (lastUpdated, sources, numbers, statuses, array order, a structured value
 * under a notes key) makes it a real change.
 */
export function isEditorialOnlyChange(before: Facility, after: Facility): boolean {
  if (canonicalStringify(before) === canonicalStringify(after)) return false;
  const [a, b] = stripPair(before, after);
  return canonicalStringify(a) === canonicalStringify(b);
}
