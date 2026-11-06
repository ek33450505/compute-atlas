"use client";

import { useEffect, useRef, useState } from "react";

const DEBOUNCE_MS = 250;

/** Matches the route's per-request operator cap (app/api/map/match/route.ts). */
export const MAX_OPERATORS_PER_REQUEST = 25;

interface Resolved {
  key: string;
  ids: Set<string> | null;
  error: boolean;
}

export interface MatchedIds {
  /** Ids allowed by the operator/minMw filters. `null` = no constraint (idle, failed, or nothing resolved yet). */
  ids: Set<string> | null;
  /** A lookup for the current filters is in flight (or debouncing). */
  pending: boolean;
  /** The lookup for the current filters failed; callers fall back to the local filters. */
  error: boolean;
}

const IDLE: MatchedIds = { ids: null, pending: false, error: false };

/**
 * Builds the `/api/map/match` query for the two filters the /map client cannot
 * evaluate locally. Operators go as repeated params (names can contain commas),
 * sorted for a stable key. Empty string means "nothing to ask the server".
 */
export function buildMatchQuery(operators: string[], minMw: number): string {
  if (operators.length === 0 && !(minMw > 0)) return "";
  const qs = new URLSearchParams();
  for (const op of [...operators].sort()) qs.append("operator", op);
  if (minMw > 0) qs.set("minMw", String(minMw));
  return qs.toString();
}

function chunkQueries(key: string): string[] {
  const params = new URLSearchParams(key);
  const operators = [...new Set(params.getAll("operator"))].sort();
  const minMw = Number(params.get("minMw") ?? 0);
  if (operators.length === 0) return [buildMatchQuery([], minMw)];
  const chunks: string[] = [];
  for (let i = 0; i < operators.length; i += MAX_OPERATORS_PER_REQUEST) {
    chunks.push(buildMatchQuery(operators.slice(i, i + MAX_OPERATORS_PER_REQUEST), minMw));
  }
  return chunks;
}

/**
 * Resolves the operator / minimum-MW filters to a set of facility ids.
 *
 * - Selections beyond the route's operator cap are split into chunks, one
 *   request each (same minMw), and the ids unioned: operators are OR'd, so
 *   the union is exact.
 * - While a new query is in flight the previous result stays in place, so the
 *   map never flashes to zero between filter changes.
 * - Requests are debounced, aborted when superseded or on unmount, and cached
 *   per chunk query.
 * - Failure is explicit (`error`), never confused with "no constraint".
 */
export function useMatchedIds(operators: string[], minMw: number): MatchedIds {
  const key = buildMatchQuery(operators, minMw);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const cache = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (key === "") return;
    const chunks = chunkQueries(key);

    const cached = chunks.map((c) => cache.current.get(c));
    if (cached.every((c): c is Set<string> => c !== undefined)) {
      setResolved({ key, ids: new Set(cached.flatMap((c) => [...c])), error: false });
      return;
    }

    const controller = new AbortController();
    const fetchChunk = async (query: string): Promise<Set<string>> => {
      const hit = cache.current.get(query);
      if (hit) return hit;
      const res = await fetch(`/api/map/match?${query}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`match ${res.status}`);
      const body = (await res.json()) as { ids?: unknown };
      if (!Array.isArray(body.ids)) throw new Error("match: malformed body");
      const ids = new Set<string>(body.ids.filter((v): v is string => typeof v === "string"));
      if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
      cache.current.set(query, ids);
      return ids;
    };

    const timer = setTimeout(async () => {
      try {
        const sets = await Promise.all(chunks.map(fetchChunk));
        if (controller.signal.aborted) return;
        setResolved({ key, ids: new Set(sets.flatMap((s) => [...s])), error: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("Map filter lookup failed; showing results without operator/capacity filters", err);
        // Keep an existing good result for this same key rather than replacing it with a failure.
        setResolved((prev) => (prev?.key === key && prev.ids ? prev : { key, ids: null, error: true }));
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  if (key === "") {
    // Filters cleared: drop the old result so a later filter never inherits it while pending.
    if (resolved !== null) setResolved(null);
    return IDLE;
  }
  if (resolved?.key === key) return { ids: resolved.ids, pending: false, error: resolved.error };
  // New key still resolving: keep showing the last good result.
  return { ids: resolved?.ids ?? null, pending: true, error: false };
}
