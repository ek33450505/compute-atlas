"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Status } from "@/lib/status";
import { STATUS_ORDER, STATUS_META } from "@/lib/status";
import { getFilterOptions, type FilterOptions } from "@/lib/filters";
import { StatusBadge } from "@/components/status-badge";
import type { Facility } from "@/lib/schema";
import type { FilterableFacility } from "@/lib/facility-slim";
import { normalizeQuery } from "@/lib/explorer-params";

// ---------------------------------------------------------------------------
// Facility-type labels
// ---------------------------------------------------------------------------

const FACILITY_TYPE_LABELS: Record<Facility["facilityType"], string> = {
  data_center: "Data center",
  crypto_mining: "Crypto mining",
  power_generation: "Power generation",
};
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Capacity options
// ---------------------------------------------------------------------------

const CAPACITY_OPTIONS = [
  { value: "0", label: "Any" },
  { value: "100", label: "≥100 MW" },
  { value: "500", label: "≥500 MW" },
  { value: "1000", label: "≥1,000 MW" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterValues {
  status: Status[];
  state: string[];
  operator: string[];
  facilityType: Facility["facilityType"][];
  minMw: number;
}

export interface FilterSetters {
  setStatus: (v: Status[]) => void;
  setState: (v: string[]) => void;
  setOperator: (v: string[]) => void;
  setFacilityType: (v: Facility["facilityType"][]) => void;
  setMinMw: (v: number) => void;
}

/** Debounced free-text search bound to the `q` URL param (table mode only). */
export interface FilterSearch {
  value: string;
  onChange: (v: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

interface FilterBarProps {
  /** Options are derived from these when `options` is not supplied (map mode). */
  facilities?: FilterableFacility[];
  /** Precomputed by the server from the full dataset (table mode). */
  options?: FilterOptions;
  values: FilterValues;
  setters: FilterSetters;
  search?: FilterSearch;
}

/**
 * Draft + debounce for the search box. While the input has focus it owns its
 * text: the URL value (trimmed server-side, arriving after an async round trip)
 * never overwrites it. The draft follows the URL only when the input is not
 * focused (Back button, external updates). On blur a pending debounce is
 * flushed and the draft settles on the normalized (trimmed, capped) form the
 * URL layer will echo, so a value that normalizes back to the current URL
 * value cannot leave stale text in the box.
 *
 * Known limit (accepted): pressing Back while the box is focused leaves the
 * draft stale until blur.
 */
function useSearchDraft(search: FilterSearch | undefined) {
  const value = search?.value ?? "";
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChangeRef = useRef(search?.onChange);
  const valueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = search?.onChange;
    valueRef.current = value;
  });

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value);
  }, [value]);

  function type(next: string) {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      onChangeRef.current?.(next);
    }, SEARCH_DEBOUNCE_MS);
  }

  function onBlur() {
    if (timer.current === undefined) {
      setDraft(valueRef.current);
      return;
    }
    clearTimeout(timer.current);
    timer.current = undefined;
    const normalized = normalizeQuery(inputRef.current?.value ?? "");
    setDraft(normalized);
    if (normalized !== valueRef.current) onChangeRef.current?.(normalized);
  }

  /** Immediate clear that also cancels any pending debounced emission. */
  function clear() {
    clearTimeout(timer.current);
    timer.current = undefined;
    setDraft("");
    onChangeRef.current?.("");
  }

  /** Clear button: the button unmounts with the text, so hand focus to the input. */
  function clearAndFocus() {
    clear();
    inputRef.current?.focus();
  }

  return { draft, type, clear, clearAndFocus, onBlur, inputRef };
}

function SearchInput({
  draft,
  onType,
  onClear,
  onBlur,
  inputRef,
}: {
  draft: string;
  onType: (v: string) => void;
  onClear: () => void;
  onBlur: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="facility-search" className="text-sm font-normal">
        Search
      </Label>
      <div className="relative">
        <input
          ref={inputRef}
          id="facility-search"
          type="search"
          autoComplete="off"
          value={draft}
          onChange={(e) => onType(e.target.value)}
          onBlur={onBlur}
          placeholder="Name, operator, city"
          className="h-8 w-52 rounded-md border border-input bg-background pl-2 pr-8 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring [&::-webkit-search-cancel-button]:appearance-none"
        />
        {draft && (
          <button
            type="button"
            onClick={onClear}
            // keep focus in the input so blur doesn't emit the typed text before clear() emits ""
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Clear search"
            className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FacetedPopover — reusable multi-select popover
// ---------------------------------------------------------------------------

interface FacetedPopoverProps {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  /** Optional display-label override per option value (defaults to the raw value). */
  getOptionLabel?: (value: string) => string;
}

function FacetedPopover({
  label,
  options,
  selected,
  onToggle,
  getOptionLabel,
}: FacetedPopoverProps) {
  const [open, setOpen] = useState(false);
  const count = selected.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-expanded={open}
        aria-label={count > 0 ? `${label} (${count} selected)` : label}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
      >
        {label}
        {count > 0 && (
          <Badge
            variant="secondary"
            className="ml-1 px-1.5 py-0 text-xs leading-tight"
            aria-hidden="true"
          >
            {count}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-52 p-2"
        align="start"
        aria-label={`${label} filter options`}
      >
        <ScrollArea className="max-h-52">
          <ul role="list" className="space-y-1 pr-2">
            {options.map((opt) => {
              const id = `facet-${label.toLowerCase()}-${opt}`;
              const checked = selected.includes(opt);
              return (
                <li key={opt} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() => onToggle(opt)}
                  />
                  <Label
                    htmlFor={id}
                    className="text-sm font-normal cursor-pointer truncate"
                  >
                    {getOptionLabel ? getOptionLabel(opt) : opt}
                  </Label>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// CapacityPopover — single-select minimum-capacity popover (mirrors FacetedPopover)
// ---------------------------------------------------------------------------

interface CapacityPopoverProps {
  value: number;
  onChange: (v: number) => void;
}

function CapacityPopover({ value, onChange }: CapacityPopoverProps) {
  const [open, setOpen] = useState(false);
  const active =
    CAPACITY_OPTIONS.find((o) => Number(o.value) === value) ?? CAPACITY_OPTIONS[0];
  const isActive = value > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-expanded={open}
        aria-label={isActive ? `Capacity (minimum ${active.label})` : "Capacity"}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
      >
        Capacity
        {isActive && (
          <Badge
            variant="secondary"
            className="ml-1 px-1.5 py-0 text-xs leading-tight"
            aria-hidden="true"
          >
            {active.label}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-52 p-2"
        align="start"
        aria-label="Minimum capacity options"
      >
        <fieldset className="border-0 p-0 m-0">
          <legend className="sr-only">Minimum capacity</legend>
          <ul role="list" className="space-y-1">
            {CAPACITY_OPTIONS.map((opt) => {
              const id = `capacity-${opt.value}`;
              const checked = Number(opt.value) === value;
              return (
                <li key={opt.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    id={id}
                    name="min-capacity"
                    value={opt.value}
                    checked={checked}
                    onChange={() => {
                      onChange(Number(opt.value));
                      setOpen(false);
                    }}
                    className="h-4 w-4 accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  />
                  <Label
                    htmlFor={id}
                    className="text-sm font-normal cursor-pointer"
                  >
                    {opt.label}
                  </Label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export function FilterBar({ facilities, options: given, values, setters, search }: FilterBarProps) {
  const options = given ?? getFilterOptions(facilities ?? []);
  const searchDraft = useSearchDraft(search);

  const { status, state, operator, facilityType, minMw } = values;
  const { setStatus, setState, setOperator, setFacilityType, setMinMw } = setters;

  // Count active filters for clear-all aria-label
  const activeCount =
    status.length +
    state.length +
    operator.length +
    facilityType.length +
    (minMw > 0 ? 1 : 0) +
    (search && searchDraft.draft ? 1 : 0);

  const hasActiveFilters = activeCount > 0;

  function toggleStatus(s: Status) {
    if (status.includes(s)) {
      setStatus(status.filter((x) => x !== s));
    } else {
      setStatus([...status, s]);
    }
  }

  function toggleState(s: string) {
    if (state.includes(s)) {
      setState(state.filter((x) => x !== s));
    } else {
      setState([...state, s]);
    }
  }

  function toggleOperator(o: string) {
    if (operator.includes(o)) {
      setOperator(operator.filter((x) => x !== o));
    } else {
      setOperator([...operator, o]);
    }
  }

  function toggleFacilityType(t: string) {
    const typed = t as Facility["facilityType"];
    if (facilityType.includes(typed)) {
      setFacilityType(facilityType.filter((x) => x !== typed));
    } else {
      setFacilityType([...facilityType, typed]);
    }
  }

  function clearAll() {
    setStatus([]);
    setState([]);
    setOperator([]);
    setFacilityType([]);
    setMinMw(0);
    searchDraft.clear();
  }

  return (
    <div
      role="search"
      aria-label="Filter facilities"
      className="flex flex-wrap items-start gap-3"
    >
      {search && (
        <SearchInput
          draft={searchDraft.draft}
          onType={searchDraft.type}
          onClear={searchDraft.clearAndFocus}
          onBlur={searchDraft.onBlur}
          inputRef={searchDraft.inputRef}
        />
      )}

      {/* Status checkboxes */}
      <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0 m-0">
        <legend className="sr-only">Status</legend>
        {(options.statuses.length > 0
          ? options.statuses
          : [...STATUS_ORDER]
        ).map((s) => {
          const id = `status-filter-${s}`;
          const checked = status.includes(s);
          return (
            <div key={s} className="flex items-center gap-1.5">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={() => toggleStatus(s)}
                aria-label={STATUS_META[s].label}
                className={cn(
                  // ui/checkbox supplies outline-2 + outline-solid (its forced-colors
                  // outline); here only the offset and colour change, and its ring-3
                  // is cancelled so just the outline draws.
                  "focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:ring-0"
                )}
              />
              <Label
                htmlFor={id}
                className="text-sm font-normal cursor-pointer"
              >
                <StatusBadge status={s} />
              </Label>
            </div>
          );
        })}
      </fieldset>

      <Separator orientation="vertical" className="h-7 self-center" />

      {/* State facet popover */}
      <FacetedPopover
        label="State"
        options={options.states}
        selected={state}
        onToggle={toggleState}
      />

      {/* Operator facet popover */}
      <FacetedPopover
        label="Operator"
        options={options.operators}
        selected={operator}
        onToggle={toggleOperator}
      />

      {/* Facility type facet popover */}
      <FacetedPopover
        label="Type"
        options={options.facilityTypes}
        selected={facilityType}
        onToggle={toggleFacilityType}
        getOptionLabel={(v) => FACILITY_TYPE_LABELS[v as Facility["facilityType"]] ?? v}
      />

      {/* Capacity popover — single-select minimum */}
      <CapacityPopover value={minMw} onChange={setMinMw} />

      {/* Clear all */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
          aria-label={`Clear all filters (${activeCount} active)`}
          className="text-muted-foreground hover:text-foreground"
        >
          Clear all
        </Button>
      )}
    </div>
  );
}
