import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadFacilities } from "@/lib/data";
import { FacilityForm, facilityToFormState } from "@/app/admin/facilities/facility-form";

interface EditFacilityPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: EditFacilityPageProps): Promise<Metadata> {
  const { id } = await params;
  return { title: `Admin — Edit ${id}` };
}

/**
 * /admin/facilities/[id] — edit-form entry. Server component loads the
 * existing facility via `loadFacilities()` (the same source `lib/data.ts`
 * exposes to every other admin/public page — no separate single-facility
 * fetch primitive exists, and this list is already cached) and converts it
 * to the form's state shape via `facilityToFormState`. 404s if no facility
 * with this id exists.
 */
export default async function EditFacilityPage({ params }: EditFacilityPageProps) {
  const { id } = await params;
  const facilities = await loadFacilities();
  const facility = facilities.find((f) => f.id === id);

  if (!facility) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-foreground">Edit facility</h1>
        <p className="text-sm text-muted-foreground">{facility.name}</p>
      </header>

      <FacilityForm mode="edit" initialState={facilityToFormState(facility)} />
    </div>
  );
}
