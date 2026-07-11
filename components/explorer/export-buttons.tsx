"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Facility } from "@/lib/schema";
import { facilitiesToCsv, facilitiesToJson } from "@/lib/export";

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ facilities }: { facilities: Facility[] }) {
  const disabled = facilities.length === 0;
  return (
    <div role="group" aria-label="Export facilities" className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={`Download ${facilities.length} facilities as CSV`}
        onClick={() =>
          triggerDownload(
            facilitiesToCsv(facilities),
            "compute-atlas-facilities.csv",
            "text/csv;charset=utf-8"
          )
        }
      >
        <Download className="size-4" aria-hidden="true" /> CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={`Download ${facilities.length} facilities as JSON`}
        onClick={() =>
          triggerDownload(
            facilitiesToJson(facilities),
            "compute-atlas-facilities.json",
            "application/json"
          )
        }
      >
        <Download className="size-4" aria-hidden="true" /> JSON
      </Button>
    </div>
  );
}
