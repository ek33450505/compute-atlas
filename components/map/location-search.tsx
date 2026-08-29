"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { Search } from "lucide-react";
import { geocodeUS, type GeocodeResult } from "@/lib/geocode";

interface LocationSearchProps {
  onSelect: (result: GeocodeResult) => void;
  className?: string;
}

type Status = "idle" | "loading" | "empty" | "error";

/**
 * Compact map search widget. Geocodes a city or ZIP via Nominatim and flies
 * the map to the matched location. Single results fly immediately; multiple
 * results render as a dropdown for the user to choose from.
 *
 * Abort handling: any in-flight request is cancelled when a new submit fires
 * or when the component unmounts.
 */
export function LocationSearch({ onSelect, className }: LocationSearchProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  // Minimum inter-submit cooldown: Nominatim allows ≤1 request/sec.
  const lastSubmitRef = useRef<number>(0);

  // Cancel any in-flight fetch on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Measured-top cap for the results dropdown, mirroring FacilityMap's Tools
  // panel (components/map/facility-map.tsx, toolsPanelMaxHeight effect): the
  // static max-h-[min(14rem,calc(100dvh-10rem))] class below assumes a fixed
  // top offset that doesn't hold on every viewport — on landscape phones
  // (e.g. 844×390) that let the dropdown claim more height than was actually
  // left below it, clipping the bottom result row with no way to scroll it
  // into view (the map's ancestor is overflow-hidden). This measures the
  // real gap from the dropdown's own top to the viewport bottom and
  // overrides the static class once known; the static class remains as the
  // pre-measurement fallback. Capped at 224px (14rem) so the dropdown
  // doesn't needlessly balloon on very tall viewports — same soft ceiling
  // the static class already used.
  const [resultsMaxHeight, setResultsMaxHeight] = useState<number | undefined>(
    undefined
  );
  useLayoutEffect(() => {
    if (results.length === 0) return;
    const el = resultsRef.current;
    if (!el) return;

    function recompute() {
      const node = resultsRef.current;
      if (!node) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const top = node.getBoundingClientRect().top;
      // 16px is a visual-extent reserve, NOT measured trailing chrome — it is
      // a different kind of number from facility-popup.tsx's 20px body buffer,
      // which reserves specific padding/border that sits after the measured
      // node. getBoundingClientRect() includes this element's border but NOT
      // its box-shadow, and the dropdown carries
      // shadow-[0_2px_8px_rgba(0,0,0,0.15)] — 2px offset + 8px blur, so ~10px
      // of it paints below the border box — plus a few px so the list does not
      // sit flush against the viewport edge. Re-measure if that shadow or the
      // border changes; the symptom of it being too small is the last result
      // row's shadow clipping at the bottom of short viewports.
      setResultsMaxHeight(Math.max(0, Math.min(224, viewportHeight - top - 16)));
    }

    recompute();
    window.addEventListener("resize", recompute);
    window.visualViewport?.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.visualViewport?.removeEventListener("resize", recompute);
    };
  }, [results.length]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;

      // Rate-guard: enforce ≥1s between Nominatim requests.
      if (Date.now() - lastSubmitRef.current < 1000) return;
      lastSubmitRef.current = Date.now();

      // Cancel previous request if still in-flight
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("loading");
      setResults([]);

      try {
        const found = await geocodeUS(trimmed, controller.signal);
        abortRef.current = null;

        if (found.length === 1) {
          onSelect(found[0]);
          setResults([]);
          setStatus("idle");
        } else if (found.length > 1) {
          setResults(found);
          setStatus("idle");
        } else {
          setStatus("empty");
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
          // Silently ignore user-initiated aborts
          return;
        }
        setStatus("error");
        abortRef.current = null;
      }
    },
    [query, onSelect]
  );

  const handleSelect = useCallback(
    (result: GeocodeResult) => {
      onSelect(result);
      setResults([]);
      setStatus("idle");
      inputRef.current?.focus();
    },
    [onSelect]
  );

  const handleRootKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape" && results.length > 0) {
        setResults([]);
        setStatus("idle");
        inputRef.current?.focus();
      }
    },
    [results.length]
  );

  const statusMessage =
    status === "loading"
      ? "Searching…"
      : status === "empty"
        ? "No places found"
        : status === "error"
          ? "Location search unavailable"
          : "";

  return (
    <div
      className={[
        "relative",
        "bg-background/95 backdrop-blur-sm border border-border rounded-sm",
        "shadow-[0_1px_4px_rgba(0,0,0,0.12)]",
        // Focus indicator for the search input lives HERE, not on the input
        // itself: the input has no border/gap before this wrapper's own
        // rounded-sm edge, so a ring drawn directly on the input would clip
        // against (or visually clash with) the wrapper's border/shadow and
        // the adjacent submit button. has-[#location-search-input:focus-visible]
        // scopes this to the input specifically — not the submit button,
        // which already carries its own focus-visible ring below — so the
        // two controls never double up a ring at once.
        "has-[#location-search-input:focus-visible]:ring-2 has-[#location-search-input:focus-visible]:ring-ring has-[#location-search-input:focus-visible]:ring-offset-1",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={handleRootKeyDown}
    >
      <form
        role="search"
        aria-label="Find a place on the map"
        onSubmit={handleSubmit}
        className="flex items-center"
      >
        {/* Visually-hidden label satisfies accessible name requirement */}
        <label htmlFor="location-search-input" className="sr-only">
          Go to city or ZIP
        </label>

        <input
          ref={inputRef}
          id="location-search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to city or ZIP"
          autoComplete="off"
          className={[
            // outline-none suppresses the browser's native ring on the input
            // itself — intentional here (not the missing-indicator bug this
            // replaces): the visible focus cue is the wrapper's
            // has-[...]:ring-* above, not this element. Never remove
            // outline-none without also removing/replacing the wrapper's
            // ring, or this input goes back to having NO focus indicator.
            "h-11 w-48 sm:w-56 bg-transparent px-2 text-sm outline-none",
            "font-mono placeholder:text-muted-foreground/60",
          ].join(" ")}
        />

        <button
          type="submit"
          aria-label="Search location"
          disabled={status === "loading"}
          className={[
            "flex h-11 w-11 flex-shrink-0 items-center justify-center",
            "cursor-pointer transition-colors",
            "text-muted-foreground hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          <Search size={14} aria-hidden="true" />
        </button>
      </form>

      {/* Results dropdown. The widget sits inside the map's overflow-hidden
          container (facility-map.tsx), so a tall list can get visually
          clipped by that ancestor before the list's own scrollbar would
          kick in — capping max-height to a viewport-relative bound (not
          just the fixed 14rem) keeps the whole dropdown within the visible
          viewport on short/mobile screens. left-0/right-0 anchor the width
          to the search widget itself, so it never exceeds the widget's own
          (already viewport-constrained, see the max-w wrapper in
          facility-map.tsx) footprint. */}
      {results.length > 0 && (
        <ul
          aria-label="Location search results"
          ref={resultsRef}
          style={
            resultsMaxHeight !== undefined
              ? { maxHeight: `${resultsMaxHeight}px` }
              : undefined
          }
          className={[
            "absolute left-0 right-0 top-full z-30 mt-0.5",
            "max-h-[min(14rem,calc(100dvh-10rem))] overflow-y-auto overscroll-contain",
            "bg-background/95 backdrop-blur-sm border border-border rounded-sm",
            "shadow-[0_2px_8px_rgba(0,0,0,0.15)]",
          ].join(" ")}
        >
          {results.map((result) => (
            <li key={`${result.lat},${result.lon}`}>
              <button
                type="button"
                onClick={() => handleSelect(result)}
                className={[
                  "w-full px-2 py-1.5 text-left text-sm font-mono",
                  "text-foreground hover:bg-muted/60 transition-colors",
                  "focus-visible:outline-none focus-visible:bg-muted/60",
                  "truncate",
                ].join(" ")}
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Live status region — screen readers announce changes */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {statusMessage}
      </div>
    </div>
  );
}
