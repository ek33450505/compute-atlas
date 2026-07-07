"use client";

import { useState } from "react";
import type { Status } from "@/lib/status";
import { STATUS_ORDER, STATUS_META } from "@/lib/status";
import { getFilterOptions } from "@/lib/filters";
import { StatusBadge } from "@/components/status-badge";
import type { Facility } from "@/lib/schema";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  minMw: number;
  q: string;
}

export interface FilterSetters {
  setStatus: (v: Status[]) => void;
  setState: (v: string[]) => void;
  setOperator: (v: string[]) => void;
  setMinMw: (v: number) => void;
  setQ: (v: string) => void;
}

interface FilterBarProps {
  facilities: Facility[];
  values: FilterValues;
  setters: FilterSetters;
}

// ---------------------------------------------------------------------------
// FacetedPopover — reusable multi-select popover
// ---------------------------------------------------------------------------

interface FacetedPopoverProps {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}

function FacetedPopover({
  label,
  options,
  selected,
  onToggle,
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
                    {opt}
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
// FilterBar
// ---------------------------------------------------------------------------

export function FilterBar({ facilities, values, setters }: FilterBarProps) {
  const options = getFilterOptions(facilities);

  const { status, state, operator, minMw, q } = values;
  const { setStatus, setState, setOperator, setMinMw, setQ } = setters;

  // Count active filters for clear-all aria-label
  const activeCount =
    status.length +
    state.length +
    operator.length +
    (minMw > 0 ? 1 : 0) +
    (q.trim().length > 0 ? 1 : 0);

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

  function clearAll() {
    setStatus([]);
    setState([]);
    setOperator([]);
    setMinMw(0);
    setQ("");
  }

  return (
    <div
      role="search"
      aria-label="Filter facilities"
      className="flex flex-wrap items-start gap-3"
    >
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
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
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

      {/* Min capacity select */}
      <div className="flex items-center gap-1.5">
        <Label htmlFor="min-capacity-select" className="text-sm whitespace-nowrap">
          Min capacity
        </Label>
        <Select
          value={String(minMw)}
          onValueChange={(v) => setMinMw(Number(v))}
        >
          <SelectTrigger
            id="min-capacity-select"
            className="w-36 h-8 text-sm"
            aria-label={`Minimum capacity: ${CAPACITY_OPTIONS.find((o) => o.value === String(minMw))?.label ?? "Any"}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CAPACITY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Search input */}
      <div className="flex items-center gap-1.5">
        <Label htmlFor="facility-search" className="sr-only">
          Search facilities
        </Label>
        <Input
          id="facility-search"
          type="search"
          placeholder="Search name, operator, city"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 w-52 text-sm"
        />
      </div>

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
