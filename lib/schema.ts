import { z } from "zod";
import { STATUS_ORDER } from "@/lib/status";
import { httpUrlSchema } from "@/lib/intake-fields";
import { stateNameFromCode } from "@/lib/us-states";

/**
 * Disable Zod's JIT schema compilation, which builds validators with the
 * `Function` constructor. Our Content-Security-Policy's `script-src`
 * deliberately omits `'unsafe-eval'` (see next.config.ts), and this module is
 * pulled into the client bundle — `facilityTypeEnum.options` feeds the
 * explorer's filter parsing — so the JIT path fired a real
 * `securitypolicyviolation` on /map (issue #236, caught by e2e/csp.spec.ts).
 *
 * Note it is not only the compile step that reports: Zod probes for eval
 * availability with a `try { Function("") }`, and a strict CSP reports that
 * caught call as a violation even though the throw is swallowed. Zod skips the
 * probe entirely under `jitless`, which is why setting this — rather than
 * relying on the throw being caught — is what actually silences it.
 *
 * Set here rather than in an app entry point so it lands wherever the schemas
 * do. Note this does NOT guarantee it runs before every schema is CONSTRUCTED
 * — `lib/intake-fields.ts` is imported above and builds `httpUrlSchema` first.
 * That is fine because Zod compiles at PARSE time, not definition time, so any
 * parse through the shared module instance sees `jitless`.
 *
 * The cost is validation throughput. Validation is mostly bulk work at
 * publish/build time, but not exclusively: `lib/contribute.ts` and
 * `lib/submissions.ts` each `safeParse` per request on the intake endpoints.
 * Those are low-frequency human submission paths, so the tradeoff is
 * acceptable — but it is a request path, not zero.
 */
z.config({ jitless: true });

/**
 * An offtaker label may carry at most ONE parenthetical, and only at the end
 * ("Meta (via Pacific Power)"), after a non-empty name that does not start
 * with whitespace or a parenthesis (so it never normalizes to an unnamed
 * group). normalizeOfftaker (lib/data.ts) strips only a trailing
 * parenthetical to group /power by buyer, so a label with a parenthetical
 * anywhere else would form its own group.
 */
export const OFFTAKER_LABEL_PATTERN = /^[^()\s][^()]*(?:\([^()]*\)\s*)?$/;

export const statusEnum = z.enum(STATUS_ORDER);
export const aiClassificationEnum = z.enum(["confirmed", "likely", "mixed_use"]);
export const confidenceEnum = z.enum(["confirmed", "reported", "rumored"]);
export const facilityTypeEnum = z.enum(["data_center", "crypto_mining", "power_generation"]);
export const sourceKindEnum = z.enum([
  "press",
  "permit",
  "osm",
  "iso_queue",
  "subsidy",
  "filing",
  "other",
]);

export const sourceSchema = z.object({
  url: httpUrlSchema,
  label: z.string().min(1),
  publisher: z.string().optional(),
  // Strict YYYY-MM-DD. A looser rule (min-length) silently accepted month-precision
  // and bare-year values from hand-curated research waves, and — because nothing
  // rejected them — publication dates entered in place of retrieval dates. Every
  // programmatic producer already emits a full date, so this only constrains
  // curation. See docs/methodology.md#scope-and-known-limitations.
  retrievedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "retrievedAt must be an ISO date (YYYY-MM-DD)"),
  kind: sourceKindEnum.default("other"),
});

export const statusEventSchema = z.object({
  status: statusEnum,
  date: z.string().min(4),
  note: z.string().optional(),
  sourceIndex: z.number().int().nonnegative().optional(),
});

// Sub-shapes extracted from `baseFacilityShape` so `lib/enrichment-update.ts`
// can compose an intent schema from the SAME field-level validation instead
// of duplicating it. Each export is the bare (non-optional) shape; call
// sites in `baseFacilityShape` below apply `.optional()` themselves.
export const capacityMwSchema = z.object({
  planned: z.number().positive().optional(),
  operational: z.number().positive().optional(),
  // What planned/operational measure. Absent = the source did not say; never
  // inferred. Not allowed on power_generation (nameplate), see
  // checkV2Consistency.
  basis: z.enum(["facility", "it", "utility_service"]).optional(),
  itPlanned: z.number().positive().optional(),
  itOperational: z.number().positive().optional(),
});

// Named separately (rather than left inline) so lib/contribute-fields.ts can
// import the exact enum for the public "energy" correction field instead of
// retyping the member list by hand — the two must never drift.
export const energySourceEnum = z.enum([
  "grid",
  "on_site_gas",
  "nuclear",
  "solar",
  "wind",
  "hydro",
  "mixed",
  "other",
]);

export const energySchema = z.object({
  source: energySourceEnum.optional(),
  utility: z.string().optional(),
  // EIA utility id; requires `utility` (checkV2Consistency) so the id cannot
  // drift apart from its name. Maintainer-curated.
  utilityEiaId: z
    .object({ id: z.number().int().positive(), sourceIndex: z.number().int().nonnegative() })
    .optional(),
  onSiteGenerationMw: z.number().positive().optional(),
  notes: z.string().optional(),
});

// `coolingType` classifies a data center's heat-rejection method BY WATER
// CONSUMPTION — that is the axis `lib/energy.ts`'s `COOLING_TYPE_ENTRIES`
// already publishes on /power ("Evaporative (high water)" ... "Air-cooled
// (minimal)"); the two must never drift, so read this comment alongside that
// file rather than re-deriving the ordering independently.
//
//   - "evaporative" — heat is rejected by evaporating water (cooling towers,
//     adiabatic/evaporative assist). Water is consumed continuously.
//   - "hybrid" — the design switches between evaporative and dry modes (e.g.
//     wet cooling in summer, dry in winter). Water is consumed seasonally. NOT
//     "a mix of air and liquid cooling" — that is rack-level heat capture, not
//     heat rejection, and it is the misreading a local model made repeatedly
//     when the rule was absent from its prompt (bench, 2026-09-01).
//   - "closed_loop" — a recirculating water/coolant circuit that is not
//     evaporated; water is consumed only as occasional makeup.
//   - "air" — NO cooling water circuit at all: dry/direct air cooling,
//     "waterless", "zero water for cooling". Water use is limited to
//     ordinary plumbing.
//   - "unknown" — a source addresses cooling but does not identify the
//     method.
//
// TIE-BREAKER (the rule that resolves the common real-world case): if the
// facility has a water circuit that recirculates, the value is
// "closed_loop" — even when heat is ultimately rejected to air via
// air-cooled chillers or dry coolers. "air" is reserved for designs with NO
// cooling water circuit. Operators very often market a closed-loop design as
// "air-cooled" — the marketing phrase alone must not decide the value; the
// presence of a recirculating water circuit does.
//
// This is `water.coolingType`, NOT `mining.coolingType` below — a separate
// enum (`immersion`/`air`/`hydro`/`hybrid`/`unknown`) for crypto-mining rigs.
// The two share the literal values "air" and "hybrid", so a mining value can
// be assigned here and still pass validation; the definitions above are the
// ones that apply to this field.
// Named separately (rather than left inline) so lib/contribute-fields.ts can
// import the exact enum for the public "water" correction field instead of
// retyping the member list by hand — the two must never drift. See the
// TIE-BREAKER rule above before treating any of these values as self-evident.
export const waterCoolingTypeEnum = z.enum([
  "evaporative",
  "air",
  "closed_loop",
  "hybrid",
  "unknown",
]);

export const waterSchema = z.object({
  coolingType: waterCoolingTypeEnum.optional(),
  reportedMgd: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

// Values are recorded in the permit's own units, exactly as printed —
// never convert, never annualize a short-term limit, and never derive a
// tonnage from capacity (MW). See the field-level notes below for the
// pollutants where the pilot found real permits diverge from what a
// naive facility-wide annual reading would assume.
export const permittedTpySchema = z.object({
  nox: z.number().nonnegative().optional(),
  co: z.number().nonnegative().optional(),
  // Total particulate matter — distinct from the PM10/PM2.5
  // size-fraction limits below; permits commonly state all three.
  pm: z.number().nonnegative().optional(),
  pm25: z.number().nonnegative().optional(),
  pm10: z.number().nonnegative().optional(),
  // Permits print this cap under either "SO2" or "SOx" — record the
  // value here regardless of the permit's own label, and note that
  // label in `notes` when it isn't "SO2". Never invent a second key
  // for SOx.
  so2: z.number().nonnegative().optional(),
  voc: z.number().nonnegative().optional(),
  // A missing `co2e` does NOT mean "no GHG limit." Some permits (e.g.
  // xAI/MZX) cap GHG only as an efficiency RATE (lb/MMBtu), with no
  // annual tonnage cap at all. Leave `co2e` undefined and explain the
  // rate-only limit in `notes` — never derive a tonnage from a rate.
  co2e: z.number().nonnegative().optional(),
  // Sulfuric acid mist.
  h2so4: z.number().nonnegative().optional(),
  // Ammonia — seen as a voluntary limit tied to SCR/urea NOx controls.
  nh3: z.number().nonnegative().optional(),
  formaldehyde: z.number().nonnegative().optional(),
  // Combined hazardous-air-pollutants cap. Individual HAPs other than
  // formaldehyde go in `notes` — they are open-ended and cannot be
  // enumerated as dedicated fields.
  hapsTotal: z.number().nonnegative().optional(),
});

// A single equipment group's limits, for permits that cap pollutants PER
// GROUP with DIFFERENT limits per group rather than one facility-wide
// number. Two real permits forced this: Crusoe Abilene's TCEQ Standard
// Permit 177263 covers 10 units that are TWO turbine models with different
// per-unit NOx limits (Solar Titan 350: 14.98 tpy vs GE LM2500: 13.44 tpy) —
// a single top-level `permittedTpy.nox` cannot represent both without
// silently asserting one model's limit for the other's units. xAI/MZX MS
// caps every pollutant PER TURBINE across THREE equipment groups, with no
// facility-wide tonnage for most pollutants at all. Deriving one blended
// facility-wide figure from per-group limits is FORBIDDEN — see the
// no-derived-numbers rule on `permittedTpy` above; it applies here with the
// same force.
export const emissionsUnitGroupSchema = z.object({
  // The permit's own name for this equipment group, verbatim (e.g. "Solar
  // Titan 350 turbines (TURBINE-1 through TURBINE-5)") — record the permit's
  // wording, never a paraphrase or a summary of it.
  label: z.string().min(1),
  // How many units of this group the permit covers, when it states one.
  unitCount: z.number().int().positive().optional(),
  // What this group's `permittedTpy` applies to. Required (unlike the
  // top-level `basis`) because a group entry exists only to carry limits, so
  // it must always say what they apply to. "group_wide" is a NEW value that
  // applies only within a group and does not exist on the top-level `basis`.
  basis: z.enum(["per_unit", "group_wide"]),
  permittedTpy: permittedTpySchema,
  // Omitting this means the group inherits the top-level `averagingPeriod`.
  averagingPeriod: z.enum(["calendar_year", "rolling_12_month", "other"]).optional(),
  notes: z.string().optional(),
});

// Permitted annual emissions limits from an air permit (PSD / Title V / state
// construction permit) — a regulatory CEILING, not measured or actual
// emissions. Never present one as the other, in copy or UI.
// Values are recorded in short tons per year (tpy), exactly as the permit
// states them. Never convert units, and never derive a tonnage from capacity
// (MW -> tons needs a capacity factor and an emission rate; a derived figure
// would be this project's first uncited number, which is not acceptable
// here). If a permit states metric tonnes or a non-annual averaging period,
// record what it says and explain the discrepancy in `notes` rather than
// normalizing it.
// `sourceIndex` must point at the permit document itself in `sources[]`.
//
// A pilot against three real air permits (Homer City PA, xAI/MZX MS,
// Waterford LA) found real permits do NOT uniformly cap emissions at the
// facility level: xAI's permit caps every pollutant PER TURBINE across three
// equipment groups, with no facility-wide tonnage for most pollutants at
// all. `basis`, `unitsCovered`, and `averagingPeriod` exist so a per-unit or
// non-calendar-year number is never mistaken for a facility-wide annual one.
export const emissionsSchema = z
  .object({
    permittedTpy: permittedTpySchema.optional(),
    // What the tonnages in `permittedTpy` apply to. Required whenever
    // `permittedTpy` carries at least one defined value (enforced by the
    // superRefine below) — a tonnage with no `basis` is ambiguous between a
    // facility total and a single unit's limit, and this project publishing
    // one as the other would be a serious factual error.
    basis: z.enum(["facility_wide", "per_unit"]).optional(),
    // The averaging window the tonnages are measured over, as the permit
    // states it. A 12-month ROLLING total is not the same as a calendar
    // year — recording either as plain "annual" silently loses that
    // distinction.
    averagingPeriod: z.enum(["calendar_year", "rolling_12_month", "other"]).optional(),
    // The equipment the permit covers, in the permit's own terms (e.g. "41
    // combustion turbines" or "Units 1-3"). Fill this whenever the permit's
    // scope might not match the tracked facility's own description — a
    // permit can authorize a materially different unit count than the
    // facility record states elsewhere, and this is the field that catches
    // that mismatch.
    unitsCovered: z.string().min(1).optional(),
    permitNumber: z.string().min(1).optional(),
    permitType: z.enum(["psd", "title_v", "minor_source", "state_construction", "other"]).optional(),
    issuingAgency: z.string().min(1).optional(),
    issuedDate: z.string().optional(),
    notes: z.string().optional(),
    sourceIndex: z.number().int().nonnegative().optional(),
    // Per-equipment-group limits, for permits that cap pollutants per group
    // with different limits per group (Crusoe Abilene, xAI/MZX MS — see
    // `emissionsUnitGroupSchema` above). Coexists with the top-level
    // `permittedTpy` fields, which the superRefine below restricts to
    // `facility_wide` only once groups are present.
    unitGroups: z.array(emissionsUnitGroupSchema).min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasDefinedPollutant =
      data.permittedTpy !== undefined &&
      Object.values(data.permittedTpy).some((value) => value !== undefined);
    if (hasDefinedPollutant && data.basis === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "a permitted tonnage is meaningless without knowing whether it applies facility-wide or per-unit — set basis",
        path: ["basis"],
      });
    }

    data.unitGroups?.forEach((group, index) => {
      const groupHasDefinedPollutant = Object.values(group.permittedTpy).some(
        (value) => value !== undefined,
      );
      if (!groupHasDefinedPollutant) {
        ctx.addIssue({
          code: "custom",
          message:
            "an equipment group with no defined pollutant values asserts nothing — record at least one limit or remove the group",
          path: ["unitGroups", index, "permittedTpy"],
        });
      }
    });

    if (data.unitGroups !== undefined) {
      const seenLabels = new Map<string, number>();
      data.unitGroups.forEach((group, index) => {
        const normalizedLabel = group.label.trim().toLowerCase();
        if (seenLabels.has(normalizedLabel)) {
          ctx.addIssue({
            code: "custom",
            message:
              "duplicate equipment group label — labels that differ only by case or whitespace make the group's limits unattributable",
            path: ["unitGroups", index, "label"],
          });
        } else {
          seenLabels.set(normalizedLabel, index);
        }
      });
    }

    if (data.unitGroups !== undefined && data.basis === "per_unit") {
      ctx.addIssue({
        code: "custom",
        message:
          "a top-level per-unit tonnage alongside per-group tonnages is ambiguous — it cannot say which group it belongs to; when unitGroups is present, top-level basis must be facility_wide (or omitted)",
        path: ["basis"],
      });
    }
  });

export const subsidySchema = z.object({
  program: z.string().optional(),
  amountUsd: z.number().nonnegative().optional(),
  jurisdiction: z.string().optional(),
  year: z
    .string()
    .regex(/^\d{4}(\/\d{4})*$/, "year must be a 4-digit year, or slash-separated 4-digit years (e.g. 2013/2015)")
    .optional(),
  sourceIndex: z.number().int().nonnegative().optional(),
});

/**
 * ⚠️ CURATION RULE — a Zod enum cannot express it, so it is written here.
 *
 * Every role below is admissible ONLY for a person acting in a PUBLIC capacity:
 * the stake must be documented in a public record, a filing, or reporting about
 * this site. A person who is merely adjacent to the site — a neighbour, an
 * objector, a private individual named in a local news comment — is never a
 * stakeholder, whatever their role would nominally be.
 *
 * Organizations (`kind: "organization"`) follow the same site-level standard: a
 * source must tie the organization to THIS site, e.g. an infrastructure fund
 * holding JV equity in one campus. An owner of the whole operator is NOT a
 * site-level stakeholder; that belongs to an operator-ownership layer, which
 * arrives separately. `lender` is organizations only (a named debt financier of
 * this project); `public_official` is people only (an agency is not an official).
 *
 * `public_official` covers any recorded official act on this site: approved,
 * signed, issued, sponsored, or voted, in EITHER direction. The note states the
 * direction of the act, never a motive.
 *
 * `landowner` is the sharp edge: it is the one value that attaches a named
 * private individual to a parcel. Admissible only from a named public-record
 * filing that ties that person to THIS site (a deed or lease cited in a permit,
 * a rezoning application, an SEC/county filing). NEVER from a residential
 * parcel lookup, a county assessor search run to find out who owns the land, or
 * an inference from an address. If a corporate entity holds the land, name the
 * entity, not a person behind it.
 *
 * The field is excluded from public intake and from every discovery lane
 * (stripped in scripts/discovery/submit-candidates.ts), so entries only ever
 * arrive by maintainer curation — which is exactly why this rule has to live
 * where the next entry is written rather than in a validator.
 */
export const stakeholderRoleEnum = z.enum([
  // financial interest
  "founder",
  "controlling_owner",
  "investor",
  "lender",
  // corporate role
  "executive",
  "board_member",
  // site-specific
  "landowner",
  // governmental role — NOT a financial interest
  "public_official",
]);

export const stakeholderKindEnum = z.enum(["person", "organization"]);

// A named person or organization with a documented stake in THIS facility.
// Site-level only: a source must tie the stakeholder to this site, never merely
// to its operator. `sourceIndex` and `asOf` are required — unlike
// jobs/community, where they are optional — because naming a real person
// without a citation is not acceptable.
export const stakeholderSchema = z
  .object({
    name: z.string().min(1),
    /** Absent means person. Optional, not defaulted, so legacy records parse unchanged. */
    kind: stakeholderKindEnum.optional(),
    role: stakeholderRoleEnum,
    /** The entity the stake runs through, e.g. "xAI". Makes the chain explicit. */
    via: z.string().min(1).optional(),
    /** One neutral sentence stating the documented relationship. */
    note: z.string().max(300).optional(),
    sourceIndex: z.number().int().nonnegative(),
    asOf: z.string().min(4),
  })
  .superRefine((s, ctx) => {
    const kind = s.kind ?? "person";
    if (s.role === "lender" && kind !== "organization") {
      ctx.addIssue({
        code: "custom",
        message: 'role "lender" is for organizations only — set kind to "organization"',
        path: ["role"],
      });
    }
    if (s.role === "public_official" && kind === "organization") {
      ctx.addIssue({
        code: "custom",
        message: 'role "public_official" is for people only — an agency is not a public official',
        path: ["role"],
      });
    }
  });

/** A stakeholder's kind, with an absent `kind` read as a person. */
export function stakeholderKind(s: { kind?: "person" | "organization" }): "person" | "organization" {
  return s.kind ?? "person";
}

export const communityStatusEnum = z.enum([
  "supported",
  "mixed",
  "contested",
  "opposed",
  "litigation",
  "unknown",
]);

// A canonical (uppercase) US state, DC or territory code. Membership goes
// through `stateNameFromCode` so the code table lives in one place; the
// uppercase regex keeps stored codes canonical. Downstream
// `splitJurisdictions` silently ignores unknown codes, so without this check a
// typo would pass validation and vanish from every state stat and route.
const jurisdictionCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "must be a 2-letter uppercase state code")
  .refine((c) => stateNameFromCode(c) !== undefined, {
    message: "not a known US state, DC or territory code",
  });

// Field paths a maintainer may mark "deliberately not recorded". This is the
// single list: scripts/discovery/extract-fields.ts derives EXTRACTABLE_FIELDS
// from it, so the extraction lane can never fill a field the schema lets you
// mark and vice versa.
export const NOT_RECORDABLE_FIELDS = [
  "capacityMw.planned",
  "capacityMw.operational",
  "energy.onSiteGenerationMw",
  "energy.source",
  "energy.utility",
  "water.coolingType",
] as const;

export const notRecordableFieldEnum = z.enum(NOT_RECORDABLE_FIELDS);
export type NotRecordableField = z.infer<typeof notRecordableFieldEnum>;

// Maintainer-curated, like `stakeholders`: excluded from public intake and
// discovery enrichment. Each reason is public prose shown on the facility page.
const notRecordedSchema = z.partialRecord(
  notRecordableFieldEnum,
  z.string().trim().min(10).max(400)
);

// Partial ISO 8601 date: YYYY, YYYY-MM or YYYY-MM-DD. Strict on shape so a
// forecast like "Q3 2027" or "2027/05" is rejected instead of stored as prose;
// calendar validity (month 13) is deliberately not checked here.
export const partialIsoDateSchema = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "date must be YYYY, YYYY-MM or YYYY-MM-DD");

const sourceIndexSchema = z.number().int().nonnegative();

// External registry ids. Each is matched on coordinates/address plus permit
// number, NEVER by name alone: plant and facility names collide across
// registries. `sourceIndex` cites where the match is documented.
const idsSchema = z.object({
  // EPA Facility Registry Service id (digits only).
  epaFrsId: z.object({ id: z.string().regex(/^\d+$/), sourceIndex: sourceIndexSchema }).optional(),
  // EIA-860 plant id: power plants, and behind-the-meter plants on compute
  // campuses.
  eiaPlantId: z
    .object({ id: z.number().int().positive(), sourceIndex: sourceIndexSchema })
    .optional(),
});

/**
 * An organization with a named role at this site.
 *
 * CURATION RULE: organizations only, never a natural person. Named people
 * belong in `stakeholders`, which carries the evidence standard for them.
 */
const partyRefSchema = z.object({
  name: z.string().trim().min(1),
  sourceIndex: sourceIndexSchema,
});
type PartyRole = "ownerEntity" | "tenant" | "endUser" | "generalContractor";

// - ownerEntity: the entity named as owner/applicant on a permit or deed
//   (often a project LLC).
// - tenant: who leases/occupies capacity from the operator.
// - endUser: the ultimate compute user.
// Arrays because joint ventures are common. tenant/endUser are rejected on
// power_generation (checkV2Consistency): `generation.offtaker` covers that.
const partiesSchema = z.object({
  ownerEntity: z.array(partyRefSchema).min(1).optional(),
  tenant: z.array(partyRefSchema).min(1).optional(),
  endUser: z.array(partyRefSchema).min(1).optional(),
  generalContractor: z.array(partyRefSchema).min(1).optional(),
});

// Dates here are FORECASTS. The actual start lives only in `statusHistory`
// (one source of truth). `permitValuationUsd` is the declared valuation on a
// building/construction permit, deliberately separate from `investmentUsd`.
const datedRefSchema = z.object({ date: partialIsoDateSchema, sourceIndex: sourceIndexSchema });
const constructionSchema = z.object({
  expectedStart: datedRefSchema.optional(),
  expectedCompletion: datedRefSchema.optional(),
  permitValuationUsd: z
    .object({
      amountUsd: z.number().positive(),
      permitNumber: z.string().min(1).optional(),
      sourceIndex: sourceIndexSchema,
    })
    .optional(),
  phases: z
    .array(
      z.object({
        name: z.string().min(1),
        mw: z.number().positive().optional(),
        expectedStart: partialIsoDateSchema.optional(),
        expectedCompletion: partialIsoDateSchema.optional(),
        sourceIndex: sourceIndexSchema,
      })
    )
    .min(1)
    .optional(),
});

// Shared fields common to every facility, regardless of type.
// Both discriminated-union branches spread this shape and add their own
// `facilityType` literal plus type-specific fields.
const baseFacilityShape = {
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/, "id must be a lowercase kebab slug"),
  name: z.string().min(1),
  operator: z.string().min(1),
  notRecorded: notRecordedSchema.optional(),
  status: statusEnum,
  confidence: confidenceEnum,
  location: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    city: z.string().optional(),
    county: z.string().optional(),
    street: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    state: jurisdictionCodeSchema,
    // "exact": the record ties lat/lon to this facility itself (its
    // footprint, plant location, a parcel it occupies in full, or a
    // single-site facility's own street-address geocode; see
    // docs/methodology.md, geocoding discipline). It must be asserted
    // explicitly, never produced by omission (a 2026-07-29 snapshot exported
    // 272 omitted values as "exact"). Records that do not say default to
    // "approximate".
    // "approximate": best-effort placement (a town or county centroid, a
    // point on a single contiguous campus, a road-level geocode).
    // "representative_multi_site": the facility spans multiple discrete
    // sites (buildings at separate addresses, or a distributed fleet of
    // mobile/modular sites) with NO single fixed location — lat/lon
    // is an illustrative point only; see `multiSite` for the real footprint.
    precision: z.enum(["exact", "approximate", "representative_multi_site"]).optional().default("approximate"),
    multiSite: z
      .object({
        states: z.array(jurisdictionCodeSchema).min(1),
        siteCountNote: z.string().optional(),
      })
      .optional(),
  }),
  capacityMw: capacityMwSchema.optional(),
  poweredBy: z.string().optional(),
  announcedDate: z.string().optional(),
  statusHistory: z.array(statusEventSchema).default([]),
  sources: z.array(sourceSchema).min(1, "at least one source is required"),
  lastUpdated: z.string().min(4),
  notes: z.string().optional(),
  // energy / power
  energy: energySchema.optional(),
  // water
  water: waterSchema.optional(),
  // air emissions (permitted limits from an air permit, not measured)
  emissions: emissionsSchema.optional(),
  // public money
  subsidies: z.array(subsidySchema).optional(),
  // economics
  investmentUsd: z.number().positive().optional(),
  landAcres: z.number().positive().optional(),
  jobs: z
    .object({
      construction: z.number().int().nonnegative().optional(),
      permanent: z.number().int().nonnegative().optional(),
      sourceIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // community
  community: z
    .object({
      status: communityStatusEnum.optional(),
      notes: z.string().optional(),
      sourceIndex: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // named people with a documented stake in this specific site
  stakeholders: z.array(stakeholderSchema).optional(),
  // v2 maintainer-curated fields (never public intake or discovery enrichment)
  ids: idsSchema.optional(),
  parties: partiesSchema.optional(),
  construction: constructionSchema.optional(),
};

// Data-center-specific environmental metrics.
const dataCenterEnvironmentalSchema = z.object({
  pue: z.number().optional(),
  pueConfidence: confidenceEnum.optional(),
  wue: z.number().optional(),
  gridCarbonIntensityGCo2PerKwh: z.number().optional(),
  renewablePercent: z.number().min(0).max(100).optional(),
  waterStress: z.enum(["low", "medium", "high", "extreme", "unknown"]).default("unknown"),
});

// Crypto-mining-specific operational fields.
const miningSchema = z.object({
  hashRateThPerS: z.number().nonnegative().optional(),
  hardwareType: z.enum(["asic", "gpu", "mixed", "unknown"]).optional(),
  coolingType: z.enum(["immersion", "air", "hydro", "hybrid", "unknown"]).optional(),
  powerArrangement: z
    .enum([
      "grid",
      "stranded_gas",
      "flared_gas",
      "curtailed_renewable",
      "behind_meter",
      "mixed",
      "unknown",
    ])
    .optional(),
});

// Crypto-mining-specific environmental metrics.
const cryptoMiningEnvironmentalSchema = z.object({
  carbonIntensityProxy: z.number().optional(),
  carbonIntensityBasis: z
    .enum(["self_reported", "grid_average", "estimated", "unknown"])
    .optional(),
});

export const dataCenterFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("data_center"),
  aiClassification: aiClassificationEnum.optional(),
  environmental: dataCenterEnvironmentalSchema.optional(),
});

export const cryptoMiningFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("crypto_mining"),
  aiClassification: aiClassificationEnum.optional(),
  mining: miningSchema.optional(),
  environmental: cryptoMiningEnvironmentalSchema.optional(),
});

// Power-generation-specific fields. Kept lean: no aiClassification, no
// mining, no environmental — capacityMw carries the generation MW and
// energy.source carries the fuel/technology at the base-shape level.
const powerGenerationSchema = z
  .object({
    technology: z
      .enum([
        "nuclear_smr",
        "nuclear",
        "fusion",
        "natural_gas",
        "solar",
        "wind",
        "hydro",
        "geothermal",
        "battery",
        "other",
      ])
      .optional(),
    // The compute company buying the power — the link back to the buildout.
    offtaker: z
      .string()
      .regex(
        OFFTAKER_LABEL_PATTERN,
        'offtaker: keep qualifiers in ONE trailing parenthetical, e.g. "Meta (via Pacific Power)"'
      )
      .optional(),
    // Facility ids of the specific compute campuses this plant powers — set
    // ONLY where a single named campus is sourced (grid-region / company-level
    // PPAs use `offtaker` alone). One-directional: the reciprocal "Powered by"
    // is derived at render time from these ids, never stored on the compute
    // record.
    poweredFacilityIds: z.array(z.string()).optional(),
    unitCount: z.number().int().positive().optional(),
    notes: z.string().optional(),
  })
  .optional();

export const powerGenerationFacilitySchema = z.object({
  ...baseFacilityShape,
  facilityType: z.literal("power_generation"),
  generation: powerGenerationSchema,
});

// Structural view of every NEW (v2) field that carries a sourceIndex. The
// helpers below are the ONE enumeration of those paths: bounds validation,
// URL-dedupe remapping and discovery staging all go through them, so a new
// sourceIndex-bearing field is added here once and cannot be missed by one
// consumer (a missed remap silently points a citation at the wrong source).
type IndexedRef = { sourceIndex: number };
export interface V2SourceIndexCarrier {
  ids?: { epaFrsId?: IndexedRef; eiaPlantId?: IndexedRef };
  energy?: { utilityEiaId?: IndexedRef };
  parties?: Partial<Record<PartyRole, IndexedRef[]>>;
  construction?: {
    expectedStart?: IndexedRef;
    expectedCompletion?: IndexedRef;
    permitValuationUsd?: IndexedRef;
    phases?: IndexedRef[];
  };
}

const PARTY_ROLES = ["ownerEntity", "tenant", "endUser", "generalContractor"] as const;

export function v2SourceIndexRefs(f: V2SourceIndexCarrier): { path: string; index: number }[] {
  const out: { path: string; index: number }[] = [];
  const add = (path: string, ref: IndexedRef | undefined) => {
    if (ref !== undefined) out.push({ path: `${path}.sourceIndex`, index: ref.sourceIndex });
  };
  add("ids.epaFrsId", f.ids?.epaFrsId);
  add("ids.eiaPlantId", f.ids?.eiaPlantId);
  add("energy.utilityEiaId", f.energy?.utilityEiaId);
  for (const role of PARTY_ROLES) {
    f.parties?.[role]?.forEach((p, i) => add(`parties.${role}[${i}]`, p));
  }
  add("construction.expectedStart", f.construction?.expectedStart);
  add("construction.expectedCompletion", f.construction?.expectedCompletion);
  add("construction.permitValuationUsd", f.construction?.permitValuationUsd);
  f.construction?.phases?.forEach((p, i) => add(`construction.phases[${i}]`, p));
  return out;
}

// Returns a NEW facility with every v2 sourceIndex replaced by
// remap(path, index). Absent fields stay absent; nothing is mutated.
export function remapV2SourceIndices<T extends V2SourceIndexCarrier>(
  f: T,
  remap: (path: string, index: number) => number
): T {
  const one = <R extends IndexedRef>(path: string, ref: R): R => ({
    ...ref,
    sourceIndex: remap(`${path}.sourceIndex`, ref.sourceIndex),
  });
  const out: T = { ...f };
  if (f.ids) {
    const ids = { ...f.ids };
    if (ids.epaFrsId) ids.epaFrsId = one("ids.epaFrsId", ids.epaFrsId);
    if (ids.eiaPlantId) ids.eiaPlantId = one("ids.eiaPlantId", ids.eiaPlantId);
    out.ids = ids;
  }
  if (f.energy?.utilityEiaId) {
    out.energy = {
      ...f.energy,
      utilityEiaId: one("energy.utilityEiaId", f.energy.utilityEiaId),
    };
  }
  if (f.parties) {
    const parties = { ...f.parties };
    for (const role of PARTY_ROLES) {
      const list = parties[role];
      if (list) parties[role] = list.map((p, i) => one(`parties.${role}[${i}]`, p));
    }
    out.parties = parties;
  }
  if (f.construction) {
    const c = { ...f.construction };
    if (c.expectedStart) c.expectedStart = one("construction.expectedStart", c.expectedStart);
    if (c.expectedCompletion)
      c.expectedCompletion = one("construction.expectedCompletion", c.expectedCompletion);
    if (c.permitValuationUsd)
      c.permitValuationUsd = one("construction.permitValuationUsd", c.permitValuationUsd);
    if (c.phases) c.phases = c.phases.map((p, i) => one(`construction.phases[${i}]`, p));
    out.construction = c;
  }
  return out;
}

// Shared cross-branch validation: sourceIndex fields must reference an
// in-range entry in `sources[]`. Hoisted so both union branches enforce it
// identically instead of duplicating the superRefine per-branch.
function checkSourceIndexBounds(
  data: V2SourceIndexCarrier & {
    sources: { url: string }[];
    statusHistory: { sourceIndex?: number }[];
    subsidies?: { sourceIndex?: number }[];
    stakeholders?: { sourceIndex?: number }[];
    jobs?: { sourceIndex?: number };
    community?: { sourceIndex?: number };
    emissions?: { sourceIndex?: number };
  },
  ctx: z.RefinementCtx
) {
  const sourceCount = data.sources.length;
  const checkIndex = (idx: number | undefined, path: (string | number)[]) => {
    if (idx !== undefined && idx >= sourceCount) {
      ctx.addIssue({
        code: "custom",
        message: `sourceIndex ${idx} is out of range (sources has ${sourceCount} item(s))`,
        path,
      });
    }
  };
  data.statusHistory.forEach((event, i) =>
    checkIndex(event.sourceIndex, ["statusHistory", i, "sourceIndex"])
  );
  data.subsidies?.forEach((s, i) =>
    checkIndex(s.sourceIndex, ["subsidies", i, "sourceIndex"])
  );
  data.stakeholders?.forEach((s, i) =>
    checkIndex(s.sourceIndex, ["stakeholders", i, "sourceIndex"])
  );
  checkIndex(data.jobs?.sourceIndex, ["jobs", "sourceIndex"]);
  checkIndex(data.community?.sourceIndex, ["community", "sourceIndex"]);
  checkIndex(data.emissions?.sourceIndex, ["emissions", "sourceIndex"]);
  for (const ref of v2SourceIndexRefs(data)) {
    const segments = ref.path
      .split(/[.[\]]+/)
      .filter(Boolean)
      .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
    checkIndex(ref.index, segments);
  }
}

// Cross-field rules for the v2 fields. Each pins a value to the context that
// makes it meaningful, so a record cannot carry a figure whose basis is lost.
function checkV2Consistency(
  data: {
    facilityType: string;
    capacityMw?: { basis?: string; planned?: number; operational?: number; itPlanned?: number; itOperational?: number };
    energy?: { utility?: string; utilityEiaId?: unknown };
    parties?: { tenant?: unknown; endUser?: unknown };
  },
  ctx: z.RefinementCtx
) {
  if (data.energy?.utilityEiaId !== undefined && data.energy.utility === undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "energy.utilityEiaId requires energy.utility (an id stored apart from its name can drift to another utility)",
      path: ["energy", "utilityEiaId"],
    });
  }
  // `basis` qualifies planned/operational; it says nothing on its own.
  // itPlanned/itOperational are their own figures and may stand alone.
  // Skipped on power_generation, where the type rule below already rejects basis.
  if (
    data.facilityType !== "power_generation" &&
    data.capacityMw?.basis !== undefined &&
    data.capacityMw.planned === undefined &&
    data.capacityMw.operational === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "basis describes a capacity figure; set planned or operational, or remove basis",
      path: ["capacityMw", "basis"],
    });
  }
  if (data.facilityType !== "power_generation") return;
  for (const role of ["tenant", "endUser"] as const) {
    if (data.parties?.[role] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `parties.${role} is not allowed on power_generation (generation.offtaker covers the buyer)`,
        path: ["parties", role],
      });
    }
  }
  for (const key of ["basis", "itPlanned", "itOperational"] as const) {
    if (data.capacityMw?.[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `capacityMw.${key} is not allowed on power_generation (capacity is generation nameplate)`,
        path: ["capacityMw", key],
      });
    }
  }
}

// A field may not be both set and marked "not recorded". Shared by every
// union branch, like checkSourceIndexBounds.
function checkNotRecordedConsistency(
  data: {
    capacityMw?: { planned?: number; operational?: number };
    energy?: { onSiteGenerationMw?: number; source?: string; utility?: string };
    water?: { coolingType?: string };
    notRecorded?: Partial<Record<NotRecordableField, string>>;
  },
  ctx: z.RefinementCtx
) {
  const valueOf: Record<NotRecordableField, unknown> = {
    "capacityMw.planned": data.capacityMw?.planned,
    "capacityMw.operational": data.capacityMw?.operational,
    "energy.onSiteGenerationMw": data.energy?.onSiteGenerationMw,
    "energy.source": data.energy?.source,
    "energy.utility": data.energy?.utility,
    "water.coolingType": data.water?.coolingType,
  };
  for (const field of NOT_RECORDABLE_FIELDS) {
    if (data.notRecorded?.[field] !== undefined && valueOf[field] !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${field} has a recorded value, so it cannot also be marked not recorded`,
        path: ["notRecorded", field],
      });
    }
  }
}

export const facilitySchema = z
  .discriminatedUnion("facilityType", [
    dataCenterFacilitySchema,
    cryptoMiningFacilitySchema,
    powerGenerationFacilitySchema,
  ])
  .superRefine(checkSourceIndexBounds)
  .superRefine(checkNotRecordedConsistency)
  .superRefine(checkV2Consistency);

export const facilitiesSchema = z.array(facilitySchema);

export type Facility = z.infer<typeof facilitySchema>;
export type DataCenterFacility = z.infer<typeof dataCenterFacilitySchema>;
export type CryptoMiningFacility = z.infer<typeof cryptoMiningFacilitySchema>;
export type PowerGenerationFacility = z.infer<typeof powerGenerationFacilitySchema>;
export type Source = z.infer<typeof sourceSchema>;
export type StatusEvent = z.infer<typeof statusEventSchema>;
