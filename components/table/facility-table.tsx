"use client";

import Link from "next/link";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
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
import type { Status } from "@/lib/status";
import { SORT_COLUMNS, type SortColumn, type SortDir } from "@/lib/table-sort";
import {
  formatCapacity,
  formatLocation,
  getDisplayedCapacityMw,
  AI_CLASSIFICATION_LABELS,
  CONFIDENCE_LABELS,
} from "@/lib/format";
import { getFacilityTypeMeta } from "@/lib/facility-type";
import { cn } from "@/lib/utils";
import type { TableRow as TableRowData } from "@/lib/facility-slim";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const columns: ColumnDef<TableRowData>[] = [
  {
    id: "name",
    header: "Name",
    accessorKey: "name",
    cell: ({ row }) => (
      <Link
        href={`/facilities/${row.original.id}`}
        title={row.original.name}
        className="block max-w-[240px] truncate font-medium text-foreground underline underline-offset-2 transition-colors motion-reduce:transition-none hover:text-primary hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
      >
        {row.original.name}
      </Link>
    ),
  },
  {
    id: "operator",
    header: "Operator",
    accessorKey: "operator",
    cell: ({ row }) => (
      <span className="block max-w-[180px] truncate" title={row.original.operator}>
        {row.original.operator}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    accessorKey: "status",
    cell: ({ row }) => <StatusBadge status={row.original.status as Status} />,
  },
  {
    id: "facilityType",
    header: "Type",
    accessorFn: (f) => getFacilityTypeMeta(f.facilityType).label,
  },
  {
    id: "aiClassification",
    header: "AI class",
    accessorFn: (f) =>
      f.facilityType === "data_center" || f.facilityType === "crypto_mining"
        ? f.aiClassification
        : undefined,
    cell: ({ row }) => {
      const f = row.original;
      const v =
        f.facilityType === "data_center" || f.facilityType === "crypto_mining"
          ? f.aiClassification
          : undefined;
      return v ? AI_CLASSIFICATION_LABELS[v] ?? v : "—";
    },
  },
  {
    id: "location",
    header: "Location",
    accessorFn: (f) => f.location.state,
    cell: ({ row }) => (
      <span
        className="block max-w-[180px] truncate"
        title={formatLocation(row.original)}
      >
        {formatLocation(row.original)}
      </span>
    ),
  },
  {
    id: "capacity",
    header: "Capacity",
    accessorFn: (f) => getDisplayedCapacityMw(f),
    cell: ({ row }) => (
      <span className="tabular-nums">{formatCapacity(row.original)}</span>
    ),
    meta: { align: "right" },
  },
  {
    id: "confidence",
    header: "Confidence",
    accessorKey: "confidence",
    cell: ({ row }) => CONFIDENCE_LABELS[row.original.confidence] ?? row.original.confidence,
  },
  {
    id: "lastUpdated",
    header: "Updated",
    accessorKey: "lastUpdated",
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
  /** One server-sorted page of rows; rendered in the order given. */
  facilities: TableRowData[];
  sort: SortColumn;
  dir: SortDir;
  /** Header buttons call this; the caller writes `sort`/`dir` to the URL. */
  onSort: (column: SortColumn, dir: SortDir) => void;
}

function isSortColumn(id: string): id is SortColumn {
  return (SORT_COLUMNS as readonly string[]).includes(id);
}

export function FacilityTable({ facilities, sort, dir, onSort }: FacilityTableProps) {
  // Sorting happens on the server (lib/table-query.ts); TanStack only renders
  // the page it is handed and reflects the URL's sort state in the headers.
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8's useReactTable returns non-memoizable functions; the React Compiler is not enabled, so this advisory is accepted. Revisit when TanStack adds compiler support.
  const table = useReactTable({
    data: facilities,
    columns,
    state: { sorting: [{ id: sort, desc: dir === "desc" }] },
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="overflow-hidden rounded-sm border border-border">
      {/* The scroll region is flush with this overflow-hidden frame, which would
          clip an outline drawn outside it entirely, so the focus outline is inset. */}
      <Table
        containerProps={{
          role: "region",
          "aria-label": "Data centers table (scroll horizontally to see more columns)",
          tabIndex: 0,
        }}
        containerClassName="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
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
                    "h-9 px-2 py-1",
                    isRightAligned && "text-right"
                  )}
                >
                  {canSort ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!isSortColumn(header.id)) return;
                        // Re-clicking the active column flips it; a new column
                        // starts descending for the numeric/date columns.
                        const next: SortDir =
                          header.id === sort
                            ? dir === "asc"
                              ? "desc"
                              : "asc"
                            : header.id === "capacity" || header.id === "lastUpdated"
                              ? "desc"
                              : "asc";
                        onSort(header.id, next);
                      }}
                      aria-label={`Sort by ${header.column.columnDef.header as string}`}
                      className="inline-flex items-center gap-0.5 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
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
                    className={cn("px-2 py-1.5", isRightAligned && "text-right")}
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
