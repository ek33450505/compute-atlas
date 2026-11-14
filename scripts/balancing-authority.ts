/**
 * Balancing authority / ISO-RTO join keys. A utility-level lookup, not a geographic one: it names the
 * BA under which EIA-861 reports the facility's utility's retail sales (or delivery) in the facility's
 * state. Only facilities with `energy.utilityEiaId` get keys.
 */
import { ISO_RTO_VALUES } from "../lib/siting-context-schema";
import type { Eia861Data, Eia861Provenance } from "./eia861";

export type IsoRto = (typeof ISO_RTO_VALUES)[number];

export const RTO_BY_BA: Readonly<Record<string, IsoRto>> = {
  PJM: "PJM",
  MISO: "MISO",
  ERCO: "ERCOT",
  CISO: "CAISO",
  NYIS: "NYISO",
  ISNE: "ISO-NE",
  SWPP: "SPP",
};

export const BA_FLAGS = ["multiple_hits:balancingAuthority", "ba_unknown"] as const;
export type BaFlag = (typeof BA_FLAGS)[number];
const isBaFlag = (f: unknown): boolean => (BA_FLAGS as readonly unknown[]).includes(f);

export interface BaIndex {
  primary: Map<string, Set<string>>;
  energy: Map<string, Set<string>>;
}
export interface BaResult {
  balancingAuthority?: string;
  isoRto?: IsoRto;
  flag?: BaFlag;
}

export function baSourceLabel(p: Eia861Provenance): string {
  return `EIA-861 ${p.year} (balancing authority of the utility's retail sales in the state)`;
}

/** Keyed `${id}|${state}`. "Bundled" and "Delivery" rows are primary, "Energy" rows are the fallback; "NA" and blank codes mean no BA. */
export function buildBaIndex(data: Eia861Data): BaIndex {
  const primary = new Map<string, Set<string>>();
  const energy = new Map<string, Set<string>>();
  for (const r of data.salesBa) {
    const code = r.baCode.trim();
    if (code === "" || code === "NA") continue;
    const target = r.serviceType === "Bundled" || r.serviceType === "Delivery" ? primary : r.serviceType === "Energy" ? energy : null;
    if (!target) continue;
    const key = `${r.id}|${r.state}`;
    const set = target.get(key) ?? new Set<string>();
    set.add(code);
    target.set(key, set);
  }
  return { primary, energy };
}

export function computeBalancingAuthority(
  facility: { location: { state?: string }; energy?: { utilityEiaId?: { id: number } } },
  idx: BaIndex,
): BaResult | null {
  const id = facility.energy?.utilityEiaId?.id;
  if (id === undefined) return null;
  const key = `${id}|${facility.location.state ?? ""}`;
  const primary = idx.primary.get(key);
  const codes = primary && primary.size > 0 ? primary : (idx.energy.get(key) ?? new Set<string>());
  if (codes.size === 0) return { flag: "ba_unknown" };
  if (codes.size > 1) return { flag: "multiple_hits:balancingAuthority" };
  const code = [...codes][0];
  const rto = RTO_BY_BA[code];
  return rto ? { balancingAuthority: code, isoRto: rto } : { balancingAuthority: code };
}

/**
 * Returns a new object; touches only the BA keys, the two BA flags and `sources.ba`. Key order is preserved:
 * every input key stays where it was, `balancingAuthority` then `isoRto` are emitted immediately before `pin`
 * (appended if there is no `pin`), the BA flag is appended last in `flags`, and `sources.ba` keeps its place
 * if present and is appended last otherwise. A `flags` key that did not exist is created where computeJoinKeysFor
 * places it: immediately before `sources` (which a result guarantees exists). A null result on an entry with no BA data serialises byte-identically.
 * Throws if there is a result and `sources` is not an object (computed entries always carry it).
 */
export function applyBalancingAuthority(
  joinKeys: Record<string, unknown>,
  result: BaResult | null,
  sourceLabel: string,
): Record<string, unknown> {
  const oldSources = joinKeys.sources;
  const sourcesIsObject = typeof oldSources === "object" && oldSources !== null && !Array.isArray(oldSources);
  if (result && !sourcesIsObject) throw new Error("applyBalancingAuthority: joinKeys.sources is missing or not an object");

  const emitBa = (out: Record<string, unknown>) => {
    if (result?.balancingAuthority) out.balancingAuthority = result.balancingAuthority;
    if (result?.isoRto) out.isoRto = result.isoRto;
  };
  const out: Record<string, unknown> = {};
  let emitted = false;
  let newFlagsPlaced = !(result?.flag && !("flags" in joinKeys));
  for (const [key, value] of Object.entries(joinKeys)) {
    if (key === "balancingAuthority" || key === "isoRto") continue;
    if (!newFlagsPlaced && result?.flag && key === "sources") {
      out.flags = [result.flag];
      newFlagsPlaced = true;
    }
    if (key === "pin" && !emitted) {
      emitBa(out);
      emitted = true;
    }
    if (key === "flags" && Array.isArray(value)) {
      const flags = value.filter((f) => !isBaFlag(f));
      if (result?.flag) flags.push(result.flag);
      if (flags.length > 0) out.flags = flags;
    } else if (key === "sources" && sourcesIsObject) {
      const sources = { ...(value as Record<string, unknown>) };
      if (result) sources.ba = sourceLabel;
      else delete sources.ba;
      out.sources = sources;
    } else {
      out[key] = value;
    }
  }
  if (!emitted) emitBa(out);
  return out;
}
