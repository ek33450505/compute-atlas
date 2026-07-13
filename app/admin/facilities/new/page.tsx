import type { Metadata } from "next";

import { loadFacilities } from "@/lib/data";
import { FacilityForm, emptyFacilityFormState } from "@/app/admin/facilities/facility-form";

export const metadata: Metadata = {
  title: "Admin — New facility",
};

/**
 * /admin/facilities/new — create-form entry. Renders `FacilityForm` in
 * "create" mode with a fresh, empty state (see `emptyFacilityFormState`).
 * Loads the existing facility list (id/name only) to populate the
 * power_generation branch's `poweredFacilityIds` combobox — the create form
 * needs the same reference list as the edit form even though it has no
 * facility of its own yet.
 */
export default async function NewFacilityPage() {
  const facilities = await loadFacilities();
  const availableFacilities = facilities.map((f) => ({ id: f.id, name: f.name }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-foreground">New facility</h1>
        <p className="text-sm text-muted-foreground">
          Add a new facility record. All fields marked required must be
          filled before this can be saved.
        </p>
      </header>

      <FacilityForm
        mode="create"
        initialState={emptyFacilityFormState()}
        availableFacilities={availableFacilities}
      />
    </div>
  );
}
