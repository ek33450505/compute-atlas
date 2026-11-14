import type { FacilityFormState } from "@/app/admin/facilities/facility-form-state";

// ---------------------------------------------------------------------------
// Keeps the form's own `sourceIndex` references pointing at the same source
// when the sources editor reorders or removes rows. Plain module (no hooks).
//
// Refs the form PAYLOAD states are handled here: statusHistory[],
// subsidies[], jobs and community. Refs the form never sends (stakeholders,
// emissions, construction.*, ...) are remapped by the server from
// `sourceOrigins`; that includes energy.utilityEiaId, which
// `facilityToFormState` strips, so the server reconciles it as a carried ref.
// The helpers' energy.utilityEiaId branches are defensive, for the day the form
// keeps it.
// ---------------------------------------------------------------------------

export type SourceRefs = Pick<
  FacilityFormState,
  "statusHistory" | "subsidies" | "jobs" | "community" | "energy"
>;

type Indexed = { sourceIndex?: number };

function mapIndex(ref: number | undefined, fn: (n: number) => number): number | undefined {
  return ref === undefined ? undefined : fn(ref);
}

function withIndex<T extends Indexed>(item: T, fn: (n: number) => number): T {
  if (item.sourceIndex === undefined) return item;
  return { ...item, sourceIndex: mapIndex(item.sourceIndex, fn) };
}

function mapRefs(refs: SourceRefs, fn: (n: number) => number): SourceRefs {
  const energy = refs.energy as { utilityEiaId?: Indexed };
  return {
    statusHistory: refs.statusHistory.map((h) => withIndex(h, fn)),
    subsidies: refs.subsidies.map((s) => withIndex(s, fn)),
    jobs: withIndex(refs.jobs as Indexed, fn) as SourceRefs["jobs"],
    community: withIndex(refs.community as Indexed, fn) as SourceRefs["community"],
    energy: (energy.utilityEiaId
      ? { ...energy, utilityEiaId: withIndex(energy.utilityEiaId, fn) }
      : refs.energy) as SourceRefs["energy"],
  };
}

/** Swaps sources `i` and `j`: refs to `i` now point at `j` and vice versa. */
export function remapRefsForSwap(refs: SourceRefs, i: number, j: number): SourceRefs {
  return mapRefs(refs, (n) => (n === i ? j : n === j ? i : n));
}

/**
 * Remaps refs after source `removed` is deleted: later refs shift down by one.
 * A ref equal to `removed` is left as is; callers must check
 * `findSourceCitations` first and refuse the removal when it is non-empty.
 */
export function remapRefsForRemove(refs: SourceRefs, removed: number): SourceRefs {
  return mapRefs(refs, (n) => (n > removed ? n - 1 : n));
}

/** Plain-words descriptions (one-based) of the form refs that cite source `index`. */
export function findSourceCitations(refs: SourceRefs, index: number): string[] {
  const found: string[] = [];
  refs.statusHistory.forEach((h, k) => {
    if (h.sourceIndex === index) found.push(`status history entry ${k + 1}`);
  });
  refs.subsidies.forEach((s, k) => {
    if (s.sourceIndex === index) found.push(`subsidy ${k + 1}`);
  });
  if ((refs.jobs as Indexed).sourceIndex === index) found.push("jobs");
  if ((refs.community as Indexed).sourceIndex === index) found.push("community");
  const eia = (refs.energy as { utilityEiaId?: Indexed }).utilityEiaId;
  if (eia?.sourceIndex === index) found.push("utility EIA id");
  return found;
}

/** "a", "a and b", "a, b and c". */
export function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const FORM_STATED_ROOTS = new Set(["statusHistory", "subsidies", "jobs", "community"]);

/**
 * Describes server issues about citations the form never sends (stakeholders,
 * emissions, construction.*, ...): paths ending in `sourceIndex` whose root is
 * not one of the form-stated refs. Paths are zero-based; entries are shown
 * one-based. Returns [] when there are none.
 */
export function describeCarriedIssuePaths(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  const out: string[] = [];
  for (const issue of issues) {
    const path = (issue as { path?: unknown } | null)?.path;
    if (!Array.isArray(path) || path.length < 2) continue;
    if (path[path.length - 1] !== "sourceIndex") continue;
    if (FORM_STATED_ROOTS.has(String(path[0]))) continue;
    const parts: string[] = [];
    for (const seg of path.slice(0, -1)) {
      parts.push(typeof seg === "number" ? `entry ${seg + 1}` : humanizeSegment(String(seg)));
    }
    const text = parts.join(" ");
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

function humanizeSegment(seg: string): string {
  return seg.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
