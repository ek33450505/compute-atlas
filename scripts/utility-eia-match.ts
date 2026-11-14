/**
 * Maintainer CLI: propose `energy.utility` -> EIA-861 utility number matches for a human to approve.
 *
 *   npm run utility:eia-review                                   build the review list (writes only the review JSON and .md)
 *   ... -- --eia861=data/eia861/f8612025.zip --out=data/utility-eia-review.json
 *   ... -- --apply-approved data/utility-eia-review.json         write approved matches to the LOCAL snapshot
 *
 * Mode 1 reads the local data/facilities.json (run `npm run db:export` first) and the pinned EIA-861
 * ZIP (scripts/eia861.ts), and writes a review JSON plus a Markdown summary beside it. It changes
 * nothing else: never data/facilities.json, never Neon. Every group starts `"approved": false`; the
 * maintainer flips it.
 *
 * Matching prefers explicit identity over inference: an alias-table entry (scripts/utility-aliases.ts)
 * or an exact normalized-name match, then a county service-territory check. There is no fuzzy or
 * token-overlap matching. A compound or hedged string ("A or B", "A (via B)") is never name-matched.
 *
 * Mode 2 patches ONLY data/facilities.json, atomically, and never touches Neon or
 * data/facilities.meta.json. It sets `energy.utilityEiaId` (plus a source for the EIA-861 page and
 * `lastUpdated`) on approved records and nothing else; `energy.utility` is never changed. It refuses
 * the whole apply (writes nothing) on any inconsistency with the review file or the EIA data, or if
 * a patched record fails schema validation. Publishing stays `npm run db:sync`.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatFatalError } from "../lib/db-error";
import { facilitySchema, v2SourceIndexRefs, type Facility } from "../lib/schema";
import { DEFAULT_EIA861_PATH, ensureEia861Zip, loadEia861, type Eia861Data } from "./eia861";
import { isEntrypoint } from "./is-entrypoint";
import { UTILITY_ALIASES, type UtilityAlias } from "./utility-aliases";

const DEFAULT_OUT = "data/utility-eia-review.json";
const REVIEW_KIND = "utility-eia-review";
const MD_HEADING = "# Utility EIA-861 match review";
const PUBLISHER = "U.S. Energy Information Administration";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- args

export interface CliOptions {
  eia861: string;
  out: string;
  applyApproved: string | null;
}

export class UsageError extends Error {}
export class ApplyRefusal extends Error {}

function flagValue(arg: string, name: string, next: () => string | undefined): string | undefined {
  if (arg === name) {
    const v = next();
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
    return v;
  }
  if (arg.startsWith(`${name}=`)) {
    const v = arg.slice(name.length + 1);
    if (!v) throw new UsageError(`${name} needs a value`);
    return v;
  }
  return undefined;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { eia861: DEFAULT_EIA861_PATH, out: DEFAULT_OUT, applyApproved: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    let v: string | undefined;
    if ((v = flagValue(arg, "--eia861", next)) !== undefined) o.eia861 = v;
    else if ((v = flagValue(arg, "--out", next)) !== undefined) o.out = v;
    else if ((v = flagValue(arg, "--apply-approved", next)) !== undefined) o.applyApproved = v;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return o;
}

// ---------------------------------------------------------------- normalization

const CANON: Record<string, string> = {
  elec: "electric", el: "electric", electrical: "electric",
  cooperative: "coop", cooperatives: "coop",
  association: "assn", pwr: "power",
  corp: "", corporation: "", co: "", company: "", inc: "", incorporated: "", llc: "", the: "", of: "", lp: "", ltd: "",
  dist: "district", membership: "member", mbr: "member", mem: "member",
  svc: "service", serv: "service", pub: "public",
  util: "utilities", utility: "utilities",
  dept: "department", auth: "authority", comm: "commission", admin: "administration",
  cnty: "county", mun: "municipal", muni: "municipal",
};

const TRAILING_ACRONYM = /\s*\(([A-Z][A-Z&.\- ]{1,7})\)\s*$/;

export function normalizeUtilityName(s: string): string {
  return s
    .replace(TRAILING_ACRONYM, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/co-op/g, "coop")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (Object.hasOwn(CANON, t) ? CANON[t] : t))
    .filter((t) => t !== "")
    .join(" ");
}

const HEDGE_RE = /\s\/\s|\/|;|\+|\bor\b|\bvia\b|\bwith\b|proximity|confirmed|interconnect|supply|assigned|option|also serves/i;
const AND_NOT_BRAND_RE = /\band\b(?!\s+(?:electric|light|power|gas|water)\b)/i;

/** True when the raw string names more than one party or hedges. Applies to the exact-name path only. */
export function isCompoundOrHedged(s: string): boolean {
  return HEDGE_RE.test(s) || AND_NOT_BRAND_RE.test(s);
}

export function countyNorm(c: string): string {
  return c
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bsaint\s/g, "st ")
    .replace(/\bst\.\s/g, "st ")
    .replace(/\./g, "")
    .replace(/\b(?:city and borough|census area|county|parish|borough|municipality|of)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * One key per record. EIA writes Virginia independent cities as "Chesapeake City", so ours, written
 * "Chesapeake (independent city)", maps ONLY to "chesapeakecity" (never to the same-named county). Any
 * other name maps to itself: "Charles City" and "Baltimore city" already end in "city", and "Bedford County"
 * stays "bedford", never matching the separate independent city of Bedford.
 */
export function countyKeys(state: string, county: string | undefined): string[] {
  if (!county || !county.trim()) return state === "DC" ? [countyNorm("District of Columbia")] : [];
  if (/\(independent city\)/i.test(county)) return [`${countyNorm(county.replace(/\([^)]*\)/g, " "))}city`];
  return [countyNorm(county)];
}

// ---------------------------------------------------------------- EIA index

export interface EiaIndex {
  presence: Set<string>;
  territoryStates: Set<string>;
  countyServing: Map<string, Set<number>>;
  byName: Map<string, Set<number>>;
  nameOf(id: number): string;
}

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const s = m.get(k);
  if (s) s.add(v);
  else m.set(k, new Set([v]));
}

export function buildEiaIndex(data: Eia861Data): EiaIndex {
  const presence = new Set<string>();
  const territoryStates = new Set<string>();
  const countyServing = new Map<string, Set<number>>();
  const byName = new Map<string, Set<number>>();
  const firstTerritoryName = new Map<number, string>();
  for (const r of data.territory) {
    presence.add(`${r.id}|${r.state}`);
    territoryStates.add(`${r.id}|${r.state}`);
    if (r.county) addTo(countyServing, `${r.state}|${countyNorm(r.county)}`, r.id);
    if (!firstTerritoryName.has(r.id)) firstTerritoryName.set(r.id, r.name);
    const n = normalizeUtilityName(r.name);
    if (n) addTo(byName, n, r.id);
  }
  for (const r of data.salesBa) presence.add(`${r.id}|${r.state}`);
  for (const u of data.utilities.values()) {
    const n = normalizeUtilityName(u.name);
    if (n) addTo(byName, n, u.id);
  }
  return {
    presence,
    territoryStates,
    countyServing,
    byName,
    nameOf: (id) => data.utilities.get(id)?.name ?? firstTerritoryName.get(id) ?? "?",
  };
}

// ---------------------------------------------------------------- aliases

const aliasKey = (state: string, name: string) => `${state}|${name.trim().toLowerCase()}`;

export function validateAliases(aliases: readonly UtilityAlias[], idx: EiaIndex): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const a of aliases) {
    const label = `${a.state} "${a.name}"`;
    if (!/^[A-Z]{2}$/.test(a.state)) problems.push(`${label}: state is not two capital letters`);
    if (a.eiaIds.length === 0) problems.push(`${label}: no eiaIds`);
    const k = aliasKey(a.state, a.name);
    if (seen.has(k)) problems.push(`${label}: duplicate (state, name)`);
    seen.add(k);
    for (const id of a.eiaIds) {
      if (!Number.isInteger(id) || id <= 0) problems.push(`${label}: ${id} is not a positive integer`);
      else if (!idx.presence.has(`${id}|${a.state}`)) problems.push(`${label}: EIA id ${id} is not present in ${a.state}`);
    }
  }
  if (problems.length) throw new Error(`utility alias table is invalid:\n  ${problems.join("\n  ")}`);
}

export function buildAliasMap(aliases: readonly UtilityAlias[]): Map<string, readonly number[]> {
  return new Map(aliases.map((a) => [aliasKey(a.state, a.name), a.eiaIds]));
}

// ---------------------------------------------------------------- classification

export type Status = "proposed" | "flagged" | "ambiguous" | "unmatched";
export type Tier = "exact" | "alias";

export interface Classification {
  status: Status;
  tier: Tier | null;
  check?: string;
  reason?: string;
  eiaId?: number;
  candidates?: number[];
}

export type Skipped = "already_set" | "no_utility";

type RecordLike = Pick<Facility, "id" | "name"> & {
  location: { state: string; county?: string };
  energy?: { utility?: string; utilityEiaId?: { id: number; sourceIndex: number } };
};

export function classifyFacility(
  f: RecordLike,
  idx: EiaIndex,
  aliasMap: Map<string, readonly number[]>,
): Classification | Skipped {
  const utility = f.energy?.utility?.trim();
  if (!utility) return "no_utility";
  if (f.energy?.utilityEiaId) return "already_set";
  const state = f.location.state;

  let tier: Tier;
  let candidates: number[];
  const aliased = aliasMap.get(aliasKey(state, utility));
  if (aliased) {
    tier = "alias";
    candidates = [...aliased];
  } else if (isCompoundOrHedged(utility)) {
    return { status: "unmatched", tier: null, reason: "compound_or_hedged" };
  } else {
    tier = "exact";
    candidates = [...(idx.byName.get(normalizeUtilityName(utility)) ?? [])].filter((id) => idx.presence.has(`${id}|${state}`));
    if (candidates.length === 0) return { status: "unmatched", tier: null, reason: "no_name_match" };
  }

  const serving = new Set<number>();
  for (const k of countyKeys(state, f.location.county)) {
    for (const id of idx.countyServing.get(`${state}|${k}`) ?? []) serving.add(id);
  }

  if (candidates.length === 1) {
    const c = candidates[0];
    if (!idx.territoryStates.has(`${c}|${state}`)) return { status: "flagged", tier, check: "no_county_data", eiaId: c };
    if (serving.size === 0) return { status: "flagged", tier, check: "county_unknown", eiaId: c };
    if (serving.has(c)) return { status: "proposed", tier, check: "county_ok", eiaId: c };
    return { status: "flagged", tier, check: "county_mismatch", eiaId: c };
  }
  const inter = candidates.filter((c) => serving.has(c));
  if (inter.length === 1) return { status: "proposed", tier, check: "county_disambiguated", eiaId: inter[0] };
  return { status: "ambiguous", tier, check: "ambiguous", candidates: inter.length ? inter : candidates };
}

// ---------------------------------------------------------------- review

export interface ReviewGroup {
  key: string;
  state: string;
  utility: string;
  tier: Tier | null;
  status: Status;
  check?: string;
  reason?: string;
  eiaId?: number;
  eiaName?: string;
  candidates?: { id: number; name: string }[];
  records: { id: string; name: string; county: string | null }[];
  approved: boolean;
}

export interface ReviewFile {
  kind: typeof REVIEW_KIND;
  generatedAt: string;
  snapshotAsOf: string | null;
  provenance: { year: number; pageUrl: string; url: string; sha256: string };
  counts: { withUtility: number; alreadySet: number; proposed: number; flagged: number; ambiguous: number; unmatched: number };
  groups: ReviewGroup[];
}

const STATUS_ORDER: Status[] = ["proposed", "flagged", "ambiguous", "unmatched"];

export function buildReview(
  facilities: readonly Facility[],
  data: Eia861Data,
  meta: { snapshotAsOf: string | null; generatedAt?: string },
  aliases: readonly UtilityAlias[] = UTILITY_ALIASES,
  idxIn?: EiaIndex,
): ReviewFile {
  const idx = idxIn ?? buildEiaIndex(data);
  const aliasMap = buildAliasMap(aliases);
  const counts = { withUtility: 0, alreadySet: 0, proposed: 0, flagged: 0, ambiguous: 0, unmatched: 0 };
  const groups = new Map<string, ReviewGroup>();
  for (const f of facilities) {
    const c = classifyFacility(f as RecordLike, idx, aliasMap);
    if (c === "no_utility") continue;
    counts.withUtility++;
    if (c === "already_set") {
      counts.alreadySet++;
      continue;
    }
    counts[c.status]++;
    const utility = (f.energy?.utility ?? "").trim();
    const state = f.location.state;
    const ids = c.eiaId !== undefined ? String(c.eiaId) : (c.candidates ?? []).join(",");
    const key = `${state}|${utility}|${c.status}|${ids}|${c.check ?? c.reason ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        state,
        utility,
        tier: c.tier,
        status: c.status,
        ...(c.check ? { check: c.check } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.eiaId !== undefined ? { eiaId: c.eiaId, eiaName: idx.nameOf(c.eiaId) } : {}),
        ...(c.candidates ? { candidates: c.candidates.map((id) => ({ id, name: idx.nameOf(id) })) } : {}),
        records: [],
        approved: false,
      };
      groups.set(key, g);
    }
    g.records.push({ id: f.id, name: f.name, county: f.location.county ?? null });
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      b.records.length - a.records.length ||
      a.key.localeCompare(b.key),
  );
  const p = data.provenance;
  return {
    kind: REVIEW_KIND,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    snapshotAsOf: meta.snapshotAsOf,
    provenance: { year: p.year, pageUrl: p.pageUrl, url: p.url, sha256: p.sha256 },
    counts,
    groups: sorted,
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function groupLine(g: ReviewGroup): string {
  const n = g.records.length;
  const head = `${n} · ${g.state} · ${oneLine(g.utility)}`;
  if (g.status === "unmatched") return `- ${head} · ${g.reason ?? "unmatched"}`;
  const tail = [g.tier, g.check].filter(Boolean).join(" · ");
  if (g.status === "ambiguous") {
    const cands = (g.candidates ?? []).map((c) => `${c.id} ${oneLine(c.name)}`).join("; ");
    return `- [ ] ${head} → ${cands} · ${tail}`;
  }
  return `- [ ] ${head} → ${oneLine(g.eiaName ?? "?")} (${g.eiaId}) · ${tail}`;
}

export function renderMarkdown(r: ReviewFile): string {
  const c = r.counts;
  const lines = [
    MD_HEADING,
    "",
    `Snapshot as of ${r.snapshotAsOf ?? "unknown"}; EIA-861 ${r.provenance.year} (${r.provenance.pageUrl}). Counts are records.`,
    "",
    "| With utility | Already set | Proposed | Flagged | Ambiguous | Unmatched |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${c.withUtility} | ${c.alreadySet} | ${c.proposed} | ${c.flagged} | ${c.ambiguous} | ${c.unmatched} |`,
  ];
  const titles: Record<Status, string> = { proposed: "Proposed", flagged: "Flagged", ambiguous: "Ambiguous", unmatched: "Unmatched" };
  for (const s of STATUS_ORDER) {
    const gs = r.groups.filter((g) => g.status === s);
    lines.push("", `## ${titles[s]} (${gs.length} groups)`, "");
    for (const g of gs) lines.push(groupLine(g));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- apply

export interface ApplyReport {
  changed: { id: string; eiaId: number; addedSource: boolean }[];
  conflicts: string[];
}

interface ApprovedGroup {
  state: string;
  utility: string;
  status: string;
  check?: string;
  eiaId?: number;
  candidates: number[];
  records: { id: string; county: string | null }[];
}

function approvedGroups(review: unknown): ApprovedGroup[] {
  const groups = (review as { groups?: unknown })?.groups;
  if (!Array.isArray(groups)) throw new ApplyRefusal("review file has no groups array");
  const out: ApprovedGroup[] = [];
  for (const g of groups as Record<string, unknown>[]) {
    if (g?.approved !== undefined && typeof g.approved !== "boolean") {
      throw new ApplyRefusal(`group "${String(g.utility)}" has a non-boolean "approved"; set it to true or false`);
    }
    if (g?.approved !== true) continue;
    const recs = g.records;
    if (typeof g.state !== "string" || typeof g.utility !== "string" || typeof g.status !== "string" || !Array.isArray(recs)) {
      throw new ApplyRefusal("malformed approved group in review file");
    }
    const records = (recs as { id?: unknown; county?: unknown }[]).map((r) => ({ id: r?.id, county: r?.county ?? null }));
    if (!records.every((x): x is { id: string; county: string | null } => typeof x.id === "string" && (x.county === null || typeof x.county === "string"))) {
      throw new ApplyRefusal(`approved group for "${g.utility}" has a malformed record`);
    }
    const cands = Array.isArray(g.candidates) ? (g.candidates as { id?: unknown }[]).map((c) => c?.id) : [];
    if (!cands.every((x): x is number => typeof x === "number")) throw new ApplyRefusal(`approved group for "${g.utility}" has malformed candidates`);
    out.push({
      state: g.state,
      utility: g.utility,
      status: g.status,
      check: typeof g.check === "string" ? g.check : typeof g.reason === "string" ? g.reason : undefined,
      eiaId: typeof g.eiaId === "number" ? g.eiaId : undefined,
      candidates: cands,
      records,
    });
  }
  return out;
}

function sameClassification(fresh: Classification, g: ApprovedGroup, chosen: number): boolean {
  if (fresh.status !== g.status || (fresh.check ?? fresh.reason) !== g.check) return false;
  if (g.status === "ambiguous") {
    const a = [...(fresh.candidates ?? [])].sort((x, y) => x - y);
    const b = [...g.candidates].sort((x, y) => x - y);
    return a.length === b.length && a.every((x, i) => x === b[i]) && a.includes(chosen);
  }
  return fresh.eiaId === g.eiaId;
}

export function applyApproved(
  records: Json[],
  review: unknown,
  idx: EiaIndex,
  data: Eia861Data,
  today: string,
  aliases: readonly UtilityAlias[] = UTILITY_ALIASES,
): { records: Json[]; report: ApplyReport } {
  const r = review as { kind?: unknown; provenance?: { sha256?: unknown } };
  if (r?.kind !== REVIEW_KIND) throw new ApplyRefusal("not a utility-eia-review file");
  if (r.provenance?.sha256 !== data.provenance.sha256) {
    throw new ApplyRefusal("review file was built from a different EIA-861 file; re-run the review");
  }
  const groups = approvedGroups(review);
  const byId = new Map(records.map((x) => [x.id as string, x]));
  const touched = new Map<string, Json>();
  const claimed = new Set<string>();
  const report: ApplyReport = { changed: [], conflicts: [] };
  const pageUrl = data.provenance.pageUrl;
  const aliasMap = buildAliasMap(aliases);

  for (const g of groups) {
    let chosen: number;
    if (g.status === "proposed" || g.status === "flagged") {
      if (g.eiaId === undefined) throw new ApplyRefusal(`approved group "${g.utility}" (${g.state}) has no eiaId`);
      chosen = g.eiaId;
    } else if (g.status === "ambiguous") {
      if (g.eiaId === undefined || !g.candidates.includes(g.eiaId)) {
        throw new ApplyRefusal(`approved ambiguous group "${g.utility}" (${g.state}) needs eiaId set to one of its candidates`);
      }
      chosen = g.eiaId;
    } else {
      throw new ApplyRefusal(`group "${g.utility}" (${g.state}) is ${g.status} and cannot be approved`);
    }
    if (!Number.isInteger(chosen) || !idx.presence.has(`${chosen}|${g.state}`)) {
      throw new ApplyRefusal(`EIA id ${chosen} is not present in ${g.state} (group "${g.utility}")`);
    }
    for (const { id, county } of g.records) {
      const orig = byId.get(id);
      if (!orig) throw new ApplyRefusal(`approved group "${g.utility}" targets unknown facility ${id}`);
      if (claimed.has(id)) throw new ApplyRefusal(`facility ${id} appears in more than one approved group`);
      claimed.add(id);
      const energy = (orig.energy ?? {}) as Json;
      const loc = (orig.location ?? {}) as Json;
      if (typeof energy.utility !== "string" || energy.utility.trim() !== g.utility || loc.state !== g.state) {
        throw new ApplyRefusal(`facility ${id} no longer has the utility/state that was reviewed; re-run the review`);
      }
      if (energy.utilityEiaId !== undefined) {
        report.conflicts.push(`${id}: utilityEiaId already set; kept existing (reviewed ${chosen})`);
        continue;
      }
      // The review file is only a list of approvals: re-derive the match from the current record.
      if ((typeof loc.county === "string" ? loc.county : null) !== county) {
        throw new ApplyRefusal(`facility ${id} no longer has the county that was reviewed; re-run the review`);
      }
      const fresh = classifyFacility(
        { id, name: String(orig.name), location: { state: g.state, county: typeof loc.county === "string" ? loc.county : undefined }, energy: { utility: energy.utility } },
        idx,
        aliasMap,
      );
      if (typeof fresh === "string" || !sameClassification(fresh, g, chosen)) {
        throw new ApplyRefusal(`facility ${id} no longer classifies as reviewed ("${g.utility}", ${g.state}); re-run the review`);
      }
      const rec = JSON.parse(JSON.stringify(orig)) as Json;
      if (rec.sources !== undefined && (!Array.isArray(rec.sources) || rec.sources.some((x) => typeof x !== "object" || x === null || Array.isArray(x)))) {
        throw new ApplyRefusal(`facility ${id} has a malformed sources array`);
      }
      const sources = (rec.sources = Array.isArray(rec.sources) ? (rec.sources as Json[]) : []);
      let sourceIndex = sources.findIndex((s) => s.url === pageUrl);
      const addedSource = sourceIndex < 0;
      if (addedSource) {
        sources.push({
          url: pageUrl,
          label: `U.S. EIA Form EIA-861, ${data.provenance.year} final data (utility number ${chosen})`,
          publisher: PUBLISHER,
          retrievedAt: today,
          kind: "other",
        });
        sourceIndex = sources.length - 1;
      }
      rec.energy = { ...(rec.energy as Json), utilityEiaId: { id: chosen, sourceIndex } };
      rec.lastUpdated = today;
      touched.set(id, rec);
      report.changed.push({ id, eiaId: chosen, addedSource });
    }
  }

  for (const [id, rec] of touched) {
    const parsed = facilitySchema.safeParse(rec);
    if (!parsed.success) throw new ApplyRefusal(`${id} fails schema validation after patch: ${parsed.error.issues[0]?.message}`);
    const nSources = Array.isArray(rec.sources) ? rec.sources.length : 0;
    const bad = v2SourceIndexRefs(rec as Parameters<typeof v2SourceIndexRefs>[0]).filter((x) => x.index >= nSources);
    if (bad.length) throw new ApplyRefusal(`${id} has out-of-range sourceIndex at ${bad[0].path}`);
  }
  return { records: records.map((x) => touched.get(x.id as string) ?? x), report };
}

// ---------------------------------------------------------------- files

function isReviewJson(text: string): boolean {
  try {
    return (JSON.parse(text) as { kind?: unknown }).kind === REVIEW_KIND;
  } catch {
    return false;
  }
}

const isReviewMd = (text: string) => text.startsWith(MD_HEADING);

/** --out must be a .json path whose target (and derived .md) is absent or a previous output of this tool. */
export function assertSafeOut(out: string): string {
  if (!/\.json$/i.test(out)) throw new UsageError("--out must end in .json");
  const md = `${out.replace(/\.json$/i, "")}.md`;
  for (const [file, isReview] of [[out, isReviewJson], [md, isReviewMd]] as const) {
    if (!existsSync(file)) continue;
    let ok = false;
    try {
      ok = isReview(readFileSync(realpathSync(file), "utf8"));
    } catch {
      ok = false;
    }
    if (!ok) throw new UsageError(`refusing to overwrite ${path.basename(file)}: it is not a previous utility-eia-review output`);
  }
  return md;
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function loadEia(root: string, eia861: string): Promise<Eia861Data> {
  return loadEia861(await ensureEia861Zip(path.resolve(root, eia861)));
}

/** File-level apply: patches data/facilities.json only (meta untouched), and only if something changed. */
export async function applyApprovedFile(
  root: string,
  reviewPath: string,
  today: string,
  opts: { eia861?: string; loadData?: () => Promise<Eia861Data>; aliases?: readonly UtilityAlias[] } = {},
): Promise<ApplyReport> {
  const file = path.join(root, "data", "facilities.json");
  const records = JSON.parse(readFileSync(file, "utf8")) as Json[];
  const review = JSON.parse(readFileSync(reviewPath, "utf8")) as unknown;
  const data = await (opts.loadData ?? (() => loadEia(root, opts.eia861 ?? DEFAULT_EIA861_PATH)))();
  const idx = buildEiaIndex(data);
  const aliases = opts.aliases ?? UTILITY_ALIASES;
  validateAliases(aliases, idx);
  const { records: next, report } = applyApproved(records, review, idx, data, today, aliases);
  if (report.changed.length > 0) writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return report;
}

export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}

function readSnapshot(root: string): Facility[] {
  const file = path.join(root, "data", "facilities.json");
  if (!existsSync(file)) throw new Error("data/facilities.json is missing; run `npm run db:export` first");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("data/facilities.json is not a non-empty array");
  const out: Facility[] = [];
  for (const r of parsed) {
    const v = facilitySchema.safeParse(r);
    if (!v.success) throw new Error("data/facilities.json has a record that fails schema validation; run `npm run db:export`");
    out.push(v.data);
  }
  return out;
}

function snapshotAsOf(root: string): string | null {
  try {
    const m = JSON.parse(readFileSync(path.join(root, "data", "facilities.meta.json"), "utf8")) as { asOf?: unknown };
    return typeof m.asOf === "string" ? m.asOf : null;
  } catch {
    return null;
  }
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const root = process.cwd();
  const outPath = opts.applyApproved ? null : path.resolve(root, opts.out);
  const mdPath = outPath ? assertSafeOut(outPath) : null;
  if (opts.applyApproved) {
    const report = await applyApprovedFile(root, path.resolve(root, opts.applyApproved), todayIso(), { eia861: opts.eia861 });
    for (const c of report.changed) console.log(`${c.id}: utilityEiaId ${c.eiaId}${c.addedSource ? " (+source)" : ""}`);
    for (const c of report.conflicts) console.log(`CONFLICT ${c}`);
    console.log(
      report.changed.length
        ? `patched ${report.changed.length} record(s) in data/facilities.json (local only; publish with npm run db:sync)`
        : "nothing to change; data/facilities.json untouched",
    );
    return 0;
  }
  const facilities = readSnapshot(root);
  const data = await loadEia(root, opts.eia861);
  const idx = buildEiaIndex(data);
  validateAliases(UTILITY_ALIASES, idx);
  const review = buildReview(facilities, data, { snapshotAsOf: snapshotAsOf(root) }, UTILITY_ALIASES, idx);
  writeAtomic(outPath as string, `${JSON.stringify(review, null, 2)}\n`);
  writeAtomic(mdPath as string, renderMarkdown(review));
  const c = review.counts;
  console.log(
    `with utility ${c.withUtility}; already set ${c.alreadySet}; proposed ${c.proposed}; flagged ${c.flagged}; ` +
      `ambiguous ${c.ambiguous}; unmatched ${c.unmatched}; groups ${review.groups.length}`,
  );
  console.log(`wrote ${opts.out} and its .md summary`);
  return 0;
}

/** main() with the exit-code contract: a UsageError prints one line and exits 2; anything else exits 1. */
export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      // lint-no-raw-error-logs: allow -- UsageError only (fixed text, the operator's own argv and a file basename; never a DB error)
      console.error(`error: ${err.message}`);
      return 2;
    }
    console.error(`utility-eia-match: ${formatFatalError(err)}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}
