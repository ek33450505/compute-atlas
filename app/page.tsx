import Link from "next/link";
import type { Metadata } from "next";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusLegend } from "@/components/status-legend";

export const metadata: Metadata = {
  title: "Home",
};

export default function HomePage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16 lg:items-start">
        {/* Hero copy */}
        <div className="space-y-6">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            US AI Datacenter Tracker
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed">
            An open civic data project tracking AI datacenter development across
            the United States. Each facility is logged by build status — from
            early proposals and permits through active construction to
            operational sites.
          </p>
          <p className="text-sm text-muted-foreground">
            Data is sourced from public permit filings, corporate announcements,
            and news records. This tracker is non-partisan and carries no
            editorial position.
          </p>

          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="#map" className={cn(buttonVariants({ size: "lg" }))}>
              Explore the map
            </Link>
            <Link
              href="/table"
              className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
            >
              View data table
            </Link>
          </div>

          <p className="text-xs text-muted-foreground pt-4">
            The interactive map and full data table are coming in the next
            milestone. This page demonstrates the foundation and status
            taxonomy.
          </p>
        </div>

        {/* Status legend */}
        <div className="lg:sticky lg:top-20">
          <StatusLegend />
        </div>
      </div>
    </div>
  );
}
