"use client";

import { useState } from "react";
import Link from "next/link";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { STATUS_ORDER, type Status } from "@/lib/status";
import {
  formatCapacity,
  formatLocation,
  getFacilityMaxMw,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Facility } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/**
 * Custom sort for Status using STATUS_ORDER index (operational first →
 * cancelled last).
 */
function statusSortFn(
  rowA: { original: Facility },
  rowB: { original: Facility }
): number {
  return (
    STATUS_ORDER.indexOf(rowA.original.status) -
    STATUS_ORDER.indexOf(rowB.original.status)
  );
}

/**
 * Custom sort for Capacity; facilities with no capacity data sort last.
 */
function capacitySortFn(
  rowA: { original: Facility },
  rowB: { original: Facility }
): number {
  const a = getFacilityMaxMw(rowA.original);
  const b = getFacilityMaxMw(rowB.original);
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

const columns: ColumnDef<Facility>[] = [
  {
    id: "name",
    header: "Name",
    accessorKey: "name",
    cell: ({ row }) => (
      <Link
        href={`/facilities/${row.original.id}`}
        className="font-medium text-foreground underline underline-offset-2 transition-colors hover:text-primary hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    id: "operator",
    header: "Operator",
    accessorKey: "operator",
  },
  {
    id: "status",
    header: "Status",
    accessorKey: "status",
    cell: ({ row }) => <StatusBadge status={row.original.status as Status} />,
    sortingFn: statusSortFn,
  },
  {
    id: "location",
    header: "Location",
    accessorFn: (f) => f.location.state,
    cell: ({ row }) => formatLocation(row.original),
  },
  {
    id: "capacity",
    header: "Capacity",
    // Return undefined (not a -1 sentinel) for no-capacity facilities so that
    // `sortUndefined: "last"` keeps them at the bottom in BOTH sort directions
    // — otherwise a descending sort floats the ~89 no-capacity rows to the top.
    accessorFn: (f) => getFacilityMaxMw(f),
    cell: ({ row }) => (
      <span className="tabular-nums">{formatCapacity(row.original)}</span>
    ),
    sortingFn: capacitySortFn,
    sortUndefined: "last",
    meta: { align: "right" },
  },
  {
    id: "confidence",
    header: "Confidence",
    accessorKey: "confidence",
    enableSorting: false,
  },
  {
    id: "lastUpdated",
    header: "Updated",
    accessorKey: "lastUpdated",
    enableSorting: false,
  },
];

// ---------------------------------------------------------------------------
// Sort icon helper
// ---------------------------------------------------------------------------

function SortIcon({ direction }: { direction: "asc" | "desc" | false }) {
  if (direction === "asc")
    return (
      <ArrowUp
        aria-hidden="true"
        className="ml-1 size-3.5 shrink-0 text-foreground"
      />
    );
  if (direction === "desc")
    return (
      <ArrowDown
        aria-hidden="true"
        className="ml-1 size-3.5 shrink-0 text-foreground"
      />
    );
  return (
    <ArrowUpDown
      aria-hidden="true"
      className="ml-1 size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FacilityTableProps {
  facilities: Facility[];
}

export function FacilityTable({ facilities }: FacilityTableProps) {
  // Default view: capacity, largest first. Every column stays user-sortable;
  // the capacity column's `sortUndefined: "last"` keeps no-capacity rows at the
  // bottom regardless of direction.
  const [sorting, setSorting] = useState<SortingState>([
    { id: "capacity", desc: true },
  ]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8's useReactTable returns non-memoizable functions; the React Compiler is not enabled, so this advisory is accepted. Revisit when TanStack adds compiler support.
  const table = useReactTable({
    data: facilities,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-sm border border-border">
      <Table>
      <TableCaption className="sr-only">
        Data centers — sortable table
      </TableCaption>

      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const canSort = header.column.getCanSort();
              const isSorted = header.column.getIsSorted();
              const isRightAligned =
                (header.column.columnDef.meta as { align?: string } | undefined)
                  ?.align === "right";

              // Map TanStack sort state to aria-sort value
              const ariaSort = !canSort
                ? undefined
                : isSorted === "asc"
                  ? ("ascending" as const)
                  : isSorted === "desc"
                    ? ("descending" as const)
                    : ("none" as const);

              return (
                <TableHead
                  key={header.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    "font-mono text-[11px] uppercase tracking-wider text-muted-foreground",
                    isRightAligned && "text-right"
                  )}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      aria-label={`Sort by ${header.column.columnDef.header as string}`}
                      className="inline-flex items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      <SortIcon direction={isSorted} />
                    </button>
                  ) : (
                    flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>

      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="py-8 text-center text-muted-foreground"
            >
              No facilities match your filters.
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const isRightAligned =
                  (
                    cell.column.columnDef.meta as
                      | { align?: string }
                      | undefined
                  )?.align === "right";
                return (
                  <TableCell
                    key={cell.id}
                    className={isRightAligned ? "text-right" : undefined}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
    </div>
  );
}
