"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown, PencilIcon, TrashIcon } from "lucide-react";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { formatCapacity, formatLocation } from "@/lib/format";
import { getFacilityTypeMeta } from "@/lib/facility-type";
import { cn } from "@/lib/utils";
import type { Facility } from "@/lib/schema";
import { deleteFacilityAction } from "@/app/admin/facilities/delete-action";

// ---------------------------------------------------------------------------
// Sort helpers (mirrors components/table/facility-table.tsx)
// ---------------------------------------------------------------------------

function statusSortFn(
  rowA: { original: Facility },
  rowB: { original: Facility }
): number {
  return (
    STATUS_ORDER.indexOf(rowA.original.status) -
    STATUS_ORDER.indexOf(rowB.original.status)
  );
}

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
// Delete confirmation (per-row)
// ---------------------------------------------------------------------------

function DeleteFacilityDialog({
  facility,
  open,
  onOpenChange,
}: {
  facility: Facility;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteFacilityAction(facility.id);
      if (result.ok) {
        toast.success(`Deleted "${facility.name}".`);
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error || "Failed to delete facility.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{facility.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            This permanently removes the facility record. This action cannot
            be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant="destructive"
            disabled={isPending}
            onClick={handleDelete}
          >
            {isPending ? "Deleting…" : "Delete facility"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Row actions cell
// ---------------------------------------------------------------------------

function RowActions({ facility }: { facility: Facility }) {
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Edit ${facility.name}`}
        render={<Link href={`/admin/facilities/${facility.id}`} />}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${facility.name}`}
        onClick={() => setDeleteOpen(true)}
      >
        <TrashIcon aria-hidden="true" />
      </Button>
      <DeleteFacilityDialog
        facility={facility}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const columns: ColumnDef<Facility>[] = [
  {
    id: "name",
    header: "Name",
    accessorKey: "name",
    cell: ({ row }) => (
      <span
        className="block max-w-[240px] truncate font-medium text-foreground"
        title={row.original.name}
      >
        {row.original.name}
      </span>
    ),
  },
  {
    id: "operator",
    header: "Operator",
    accessorKey: "operator",
    cell: ({ row }) => (
      <span
        className="block max-w-[180px] truncate"
        title={row.original.operator}
      >
        {row.original.operator}
      </span>
    ),
  },
  {
    id: "state",
    header: "State",
    accessorFn: (f) => f.location.state,
    cell: ({ row }) => formatLocation(row.original),
  },
  {
    id: "status",
    header: "Status",
    accessorKey: "status",
    cell: ({ row }) => <StatusBadge status={row.original.status as Status} />,
    sortingFn: statusSortFn,
  },
  {
    id: "facilityType",
    header: "Type",
    accessorFn: (f) => getFacilityTypeMeta(f.facilityType).label,
  },
  {
    id: "capacity",
    header: "Capacity",
    accessorFn: (f) => f.capacityMw?.operational ?? f.capacityMw?.planned,
    cell: ({ row }) => (
      <span className="tabular-nums">{formatCapacity(row.original)}</span>
    ),
    sortUndefined: "last",
    meta: { align: "right" },
  },
  {
    id: "lastUpdated",
    header: "Updated",
    accessorKey: "lastUpdated",
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => <RowActions facility={row.original} />,
    enableSorting: false,
    meta: { align: "right" },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FacilityAdminTableProps {
  facilities: Facility[];
}

export function FacilityAdminTable({ facilities }: FacilityAdminTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8's useReactTable returns non-memoizable functions; the React Compiler is not enabled, so this advisory is accepted. Mirrors components/table/facility-table.tsx.
  const table = useReactTable({
    data: facilities,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button render={<Link href="/admin/facilities/new" />}>
          New facility
        </Button>
      </div>

      <div className="overflow-hidden rounded-sm border border-border">
        <Table>
          <TableCaption className="sr-only">
            Facilities — sortable admin table with edit and delete actions
          </TableCaption>

          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const isSorted = header.column.getIsSorted();
                  const isRightAligned =
                    (
                      header.column.columnDef.meta as
                        | { align?: string }
                        | undefined
                    )?.align === "right";

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
                  No facilities found.
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
                        className={cn(
                          "px-2 py-1.5",
                          isRightAligned && "text-right"
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
