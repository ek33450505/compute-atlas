"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Facility, Source } from "@/lib/schema";
import { FacilitySourceIndexPicker } from "@/app/admin/facilities/facility-source-index-picker";

// ---------------------------------------------------------------------------
// jobs{} / community{} fieldsets (Phase 2b-4).
//
// Both are plain OPTIONAL nested objects (no arrays), each with its own
// `sourceIndex?` referencing `sources[]` via the shared
// `FacilitySourceIndexPicker` built in 2b-3. Same shallow-merge whole-object
// submission rule as every other nested-object section in this phase.
// ---------------------------------------------------------------------------

type JobsState = NonNullable<Facility["jobs"]> | Record<string, never>;
type CommunityState = NonNullable<Facility["community"]> | Record<string, never>;

const COMMUNITY_STATUS_LABELS: Record<
  NonNullable<NonNullable<Facility["community"]>["status"]>,
  string
> = {
  supported: "Supported",
  mixed: "Mixed",
  contested: "Contested",
  opposed: "Opposed",
  litigation: "Litigation",
  unknown: "Unknown",
};

export interface FacilityJobsCommunitySectionProps {
  jobs: JobsState;
  community: CommunityState;
  sources: Source[];
  onChangeJobs: (next: JobsState) => void;
  onChangeCommunity: (next: CommunityState) => void;
}

/** Parses a nonneg-int field's raw input into a stored value, or undefined for blank. */
function parseNonnegInt(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export function FacilityJobsCommunitySection({
  jobs,
  community,
  sources,
  onChangeJobs,
  onChangeCommunity,
}: FacilityJobsCommunitySectionProps) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jobs.construction">Construction jobs (optional)</Label>
              <Input
                id="jobs.construction"
                name="jobs.construction"
                type="number"
                min={0}
                step={1}
                value={jobs.construction != null ? String(jobs.construction) : ""}
                onChange={(e) =>
                  onChangeJobs({ ...jobs, construction: parseNonnegInt(e.target.value) })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="jobs.permanent">Permanent jobs (optional)</Label>
              <Input
                id="jobs.permanent"
                name="jobs.permanent"
                type="number"
                min={0}
                step={1}
                value={jobs.permanent != null ? String(jobs.permanent) : ""}
                onChange={(e) =>
                  onChangeJobs({ ...jobs, permanent: parseNonnegInt(e.target.value) })
                }
              />
            </div>
          </div>

          <div className="sm:max-w-xs">
            <FacilitySourceIndexPicker
              id="jobs.sourceIndex"
              label="Source (optional)"
              sources={sources}
              value={jobs.sourceIndex}
              onChange={(index) => onChangeJobs({ ...jobs, sourceIndex: index })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Community</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="community.status">Status (optional)</Label>
            <Select
              value={community.status ?? ""}
              onValueChange={(v) =>
                onChangeCommunity({
                  ...community,
                  status: v as NonNullable<Facility["community"]>["status"],
                })
              }
            >
              <SelectTrigger id="community.status" className="w-full">
                <SelectValue placeholder="Select a status" />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(COMMUNITY_STATUS_LABELS) as [
                    keyof typeof COMMUNITY_STATUS_LABELS,
                    string,
                  ][]
                ).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="community.notes">Notes (optional)</Label>
            <Input
              id="community.notes"
              name="community.notes"
              value={community.notes ?? ""}
              onChange={(e) => onChangeCommunity({ ...community, notes: e.target.value })}
            />
          </div>

          <div className="sm:max-w-xs">
            <FacilitySourceIndexPicker
              id="community.sourceIndex"
              label="Source (optional)"
              sources={sources}
              value={community.sourceIndex}
              onChange={(index) => onChangeCommunity({ ...community, sourceIndex: index })}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
