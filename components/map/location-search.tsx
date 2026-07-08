"use client";

import { useState, useRef, useEffect, useCallback } from "react";
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

      {/* Results dropdown */}
      {results.length > 0 && (
        <ul
          aria-label="Location search results"
          ref={resultsRef}
          className={[
            "absolute left-0 right-0 top-full z-30 mt-0.5",
            "max-h-56 overflow-y-auto",
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
