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
 * Nested keys only a maintainer may write (via `db:sync`, which writes full docs
 * and does not use this merge). A patch that replaces the parent object does not
 * wipe them: `mergeFacilityPatch` carries them over from the existing doc, but
 * only while what each describes is unchanged.
 */
const CURATED_NESTED_KEYS = {
  capacityMw: ["basis", "itPlanned", "itOperational"],
  energy: ["utilityEiaId"],
} as const;

function carryCuratedKeys(
  base: Record<string, unknown>,
  merged: Record<string, unknown>,
  field: keyof typeof CURATED_NESTED_KEYS
): void {
  const patched = merged[field];
  const old = base[field];
  if (patched === old || !isPlainObject(patched) || !isPlainObject(old)) return;
  if (field === "capacityMw" && merged.facilityType === "power_generation") return;
  const next = withoutUndefined(patched);
  for (const key of CURATED_NESTED_KEYS[field]) {
    // An explicit null counts as stated: it stays and fails schema validation.
    if (next[key] !== undefined || old[key] === undefined) continue;
    if (key === "basis" && (next.planned !== old.planned || next.operational !== old.operational)) continue;
    if (key === "utilityEiaId" && next.utility !== old.utility) continue;
    next[key] = old[key];
  }
  merged[field] = next;
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
 * deeper merge is needed yet, with one exception: a plain-object `capacityMw`
 * or `energy` patch keeps the maintainer-curated nested keys of `CURATED_NESTED_KEYS`
 * from the existing doc when the patch does not state them (see below).
 *
 * Curated carry: discovery stages FULL docs as `update` payloads, so a
 * `capacityMw: {planned: 100}` would otherwise wipe `basis`, `itPlanned` and
 * `itOperational`, and an `energy` patch `utilityEiaId`. No lane or public path may
 * write those keys, so they are carried over, but only while the thing each
 * describes is UNCHANGED: a curated value about something the patch changed is
 * stale, and dropping it is correct (a maintainer re-adds it via `db:sync`).
 * So `utilityEiaId` is carried only when the merged `energy.utility` === the
 * existing one, and `basis` only when the merged `planned` and `operational`
 * both === the existing ones (`itPlanned`/`itOperational` are independent
 * figures and always carry). No capacityMw keys are carried when the merged
 * `facilityType` is "power_generation" (the schema rejects them there). An
 * explicit `null` in the patch counts as stated: it stays and fails validation.
 * Consequence: a patch cannot clear them while what they describe is unchanged;
 * only a full-doc write (`db:sync`) can, which is intended. Non-curated nested
 * keys keep the replace semantics.
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
  carryCuratedKeys(base, merged, "capacityMw");
  carryCuratedKeys(base, merged, "energy");
  const patchLocation = Object.hasOwn(patch, "location") ? patch.location : undefined;
  if (isPlainObject(patchLocation)) {
    const stated = withoutUndefined(patchLocation);
    if (PIN_KEYS.every((key) => !Object.hasOwn(stated, key))) {
      merged.location = { ...(isPlainObject(base.location) ? base.location : {}), ...stated };
    }
  }
  return merged;
}
