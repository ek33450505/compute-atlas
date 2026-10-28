/**
 * The one definition of how a facility PATCH merges onto the stored doc.
 * `updateFacility` (the write), `stageLeadSubmission` (update pre-validation),
 * the admin submission diff preview and the public-correction pre-validation
 * all call it, so the preview, the pre-validation and the write cannot
 * disagree. A dependency-free leaf module (like `lib/counties.ts`) so a server
 * component or a bare `tsx` CLI can import it without pulling in the DB client.
 */

/** True for a non-null, non-array object: the only shape a facility patch may take. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `location` keys that restate where a facility is; a patch carrying any of them is a new pin. */
const PIN_KEYS = ["lat", "lon", "state"] as const;

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/**
 * Shallow top-level merge of `patch` onto `existing`, with one exception: a
 * `location` patch that restates none of lat, lon or state (a `city`, `county`,
 * `street`, `postalCode` or `precision` edit) is shallow-merged over the
 * existing location, so a small edit keeps the stored pin and its precision.
 * A `location` that carries any of lat, lon or state is a new pin and REPLACES
 * the location wholesale: the old `city`/`county`/`street` described the old
 * pin and must not survive, and an omitted `precision` falls to the schema
 * default ("approximate") instead of inheriting "exact", which must be asserted
 * explicitly, never produced by omission (see `lib/schema.ts`). This also
 * covers the admin form, which always sends lat, lon, state and precision, so
 * a blanked `city` or `county` is cleared. Keys with an `undefined` value
 * count as absent. A non-object `location` replaces and fails schema
 * validation. Every other top-level field replaces wholesale. YAGNI — no
 * deeper merge is needed yet.
 *
 * A patch that is not a plain object changes nothing; `updateFacility` rejects
 * it with a 400 before calling this. Does not force `id` and does not validate;
 * callers pin `id` and run `facilitySchema` on the result. Neither argument is
 * mutated.
 */
export function mergeFacilityPatch(
  existing: object | null | undefined,
  patch: unknown
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...existing };
  if (!isPlainObject(patch)) {
    return base;
  }
  const merged: Record<string, unknown> = { ...base, ...patch };
  const patchLocation = Object.hasOwn(patch, "location") ? patch.location : undefined;
  if (isPlainObject(patchLocation)) {
    const stated = withoutUndefined(patchLocation);
    if (PIN_KEYS.every((key) => !Object.hasOwn(stated, key))) {
      merged.location = { ...(isPlainObject(base.location) ? base.location : {}), ...stated };
    }
  }
  return merged;
}
