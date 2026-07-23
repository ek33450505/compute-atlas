import { Suspense } from "react";
import type { Metadata } from "next";

import { getAllFacilities } from "@/lib/data";
import { Explorer } from "@/components/explorer/explorer";
import { GraticuleSurvey } from "@/components/home/graticule-survey";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Data table",
  description:
    "Filterable, sortable table of all tracked data centers in the United States — shares filter state with the map.",
};

/**
 * /table — the accessible, filterable, sortable data view.
 * Renders Explorer in `table` mode so it shares the map's nuqs URL filter
 * state; the header stays server-rendered, the Explorer subtree hydrates
 * client-side (Suspense boundary required for useSearchParams / nuqs).
 */
export default async function TablePage() {
  const facilities = await getAllFacilities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="relative mb-8">
        <GraticuleSurvey className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />
        <div className="relative space-y-3">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            United States · Edition 2026 · Gazetteer
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Data center data table
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Compute Atlas tracks data centers across the United States —
            traditional and hyperscale compute, AI-specific facilities, and
            crypto-mining operations — with a public source behind every
            record. Every tracked facility is listed below, filterable and
            sortable. Filters are shared with the map — the URL carries them
            between the two views. Each row links to its detail plate.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      <Suspense>
        <Explorer facilities={facilities} mode="table" />
      </Suspense>
    </div>
  );
}
