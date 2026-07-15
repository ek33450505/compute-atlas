"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  searchCommands,
  facilityToSearchEntry,
  mergeFacilityResults,
  SEARCH_GROUP_LABELS,
  type SearchEntry,
} from "@/lib/search";
import type { Facility } from "@/lib/schema";

interface CommandPaletteProps {
  index: SearchEntry[];
  navLinks: readonly { readonly label: string; readonly href: string }[];
}

// Stable empty-array reference for the empty-query case so the useMemo that
// depends on shownDbEntries doesn't see a new array identity every render.
const EMPTY_SEARCH_ENTRIES: SearchEntry[] = [];

/**
 * Site-wide ⌘K / Ctrl+K command palette. Renders both the header trigger
 * button and the modal itself, sharing open/query state. Does content search
 * (facilities/operators/states) and page navigation in one place.
 */
export function CommandPalette({ index, navLinks }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isMac, setIsMac] = useState(false);
  const [prevQuery, setPrevQuery] = useState(query);
  const [dbEntries, setDbEntries] = useState<SearchEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);

  // Detect platform once on mount; default to non-Mac ("Ctrl K") for SSR/
  // first paint to avoid a hydration mismatch. `navigator` is unavailable
  // during SSR, so this correction can only happen in an effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe browser-only mount detection; no external state to sync against.
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  // Global ⌘K / Ctrl+K shortcut.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Debounced live DB full-text search. Augments the instant client-side Fuse
  // results with facilities matched by their notes/description content (which
  // the name-only Fuse index can't see). Race-safe: each run aborts the prior
  // in-flight request, so only the latest query's results are applied. Degrades
  // silently to Fuse-only when the DB is unavailable or the fetch fails.
  const trimmedQuery = query.trim();

  useEffect(() => {
    if (!trimmedQuery) {
      // Nothing to search — no setState here; dbEntries/isSearching are
      // derived to their empty/idle state below via trimmedQuery instead.
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmedQuery)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setDbEntries([]);
          return;
        }
        const data: { facilities?: Facility[] } = await res.json();
        setDbEntries((data.facilities ?? []).map(facilityToSearchEntry));
      } catch (err) {
        // Ignore aborts (superseded by a newer keystroke); on any other failure
        // degrade to Fuse-only results.
        if ((err as Error).name !== "AbortError") setDbEntries([]);
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery]);

  // Derived, not stored: an empty query always shows no DB entries and never
  // shows the searching indicator, regardless of stale state left over from
  // a prior non-empty query (avoids the synchronous-setState-in-effect reset).
  // Memoized (not just `trimmedQuery ? dbEntries : []`) so the empty case
  // returns a stable reference — a fresh [] on every render would defeat the
  // useMemo below that depends on shownDbEntries.
  const shownDbEntries = useMemo(
    () => (trimmedQuery ? dbEntries : EMPTY_SEARCH_ENTRIES),
    [trimmedQuery, dbEntries]
  );
  const showSearching = Boolean(trimmedQuery) && isSearching;

  const allEntries = useMemo<SearchEntry[]>(() => {
    const pages: SearchEntry[] = [
      { type: "page", label: "Home", href: "/", keywords: "home" },
      ...navLinks.map((l) => ({
        type: "page" as const,
        label: l.label,
        href: l.href,
        keywords: l.label.toLowerCase(),
      })),
    ];
    return [...pages, ...index];
  }, [index, navLinks]);

  const fuseGroups = useMemo(() => searchCommands(allEntries, query), [allEntries, query]);
  const groups = useMemo(
    () => mergeFacilityResults(fuseGroups, shownDbEntries),
    [fuseGroups, shownDbEntries]
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset the active option whenever the query (and thus results) changes.
  // Adjusted during render (React's recommended pattern) rather than in an
  // effect, to avoid an extra cascading render on every keystroke.
  if (query !== prevQuery) {
    setPrevQuery(query);
    setActiveIndex(0);
  }

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, flat.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[activeIndex];
        if (item) go(item.href);
      }
    },
    [flat, activeIndex, go]
  );

  const activeId = flat[activeIndex] ? `cmdk-opt-${activeIndex}` : undefined;
  const resultCountMessage = showSearching
    ? "Searching…"
    : trimmedQuery && flat.length === 0
      ? "No results"
      : `${flat.length} ${flat.length === 1 ? "result" : "results"}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search (press Ctrl K or Command K)"
        className="flex h-11 items-center gap-2 rounded-lg px-2 sm:px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Search aria-hidden className="size-4" />
        <span className="hidden sm:inline font-mono text-xs">Search</span>
        <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
          <Dialog.Popup
            initialFocus={inputRef}
            className="fixed left-1/2 top-[14vh] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-sm border border-border bg-popover text-popover-foreground shadow-lg transition duration-150 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <Dialog.Title className="sr-only">Search Compute Atlas</Dialog.Title>
            <Dialog.Description className="sr-only">
              Search facilities, operators, and states, or jump to a page. Use
              the arrow keys to navigate results and Enter to select.
            </Dialog.Description>

            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <label htmlFor="cmdk-input" className="sr-only">
                Search facilities, operators, states, or pages
              </label>
              <input
                ref={inputRef}
                id="cmdk-input"
                type="text"
                role="combobox"
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls="cmdk-listbox"
                aria-activedescendant={activeId}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search facilities, operators, states…"
                className="h-12 w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>

            <ul
              id="cmdk-listbox"
              role="listbox"
              aria-label="Search results"
              className="max-h-[60vh] overflow-y-auto py-1"
            >
              {groups.map((group) => {
                let groupStart = 0;
                for (const g of groups) {
                  if (g === group) break;
                  groupStart += g.items.length;
                }
                return (
                  <li key={group.type}>
                    <div className="px-3 pb-1 pt-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                      {SEARCH_GROUP_LABELS[group.type]}
                    </div>
                    <ul>
                      {group.items.map((item, i) => {
                        const flatIndex = groupStart + i;
                        const isActive = flatIndex === activeIndex;
                        return (
                          <li
                            key={`${item.type}-${item.href}`}
                            id={`cmdk-opt-${flatIndex}`}
                            role="option"
                            aria-selected={isActive}
                            ref={isActive ? activeItemRef : undefined}
                          >
                            <button
                              type="button"
                              onClick={() => go(item.href)}
                              onMouseEnter={() => setActiveIndex(flatIndex)}
                              className={cn(
                                "flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-mono text-sm text-foreground transition-colors",
                                isActive && "bg-muted/60"
                              )}
                            >
                              <span className="truncate">{item.label}</span>
                              {item.sublabel && (
                                <span className="shrink-0 truncate text-xs text-muted-foreground">
                                  {item.sublabel}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}

              {trimmedQuery && groups.length === 0 && !showSearching && (
                <li className="px-3 py-6 text-center font-mono text-sm text-muted-foreground">
                  No matches for &ldquo;{query}&rdquo;.
                </li>
              )}
            </ul>

            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {resultCountMessage}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
