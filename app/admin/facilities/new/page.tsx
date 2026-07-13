import type { Metadata } from "next";

import { FacilityForm, emptyFacilityFormState } from "@/app/admin/facilities/facility-form";

export const metadata: Metadata = {
  title: "Admin — New facility",
};

/**
 * /admin/facilities/new — create-form entry. Renders `FacilityForm` in
 * "create" mode with a fresh, empty state (see `emptyFacilityFormState`).
 * No data to load — this is a plain client-rendered form shell.
 */
export default function NewFacilityPage() {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl text-foreground">New facility</h1>
        <p className="text-sm text-muted-foreground">
          Add a new facility record. All fields marked required must be
          filled before this can be saved.
        </p>
      </header>

      <FacilityForm mode="create" initialState={emptyFacilityFormState()} />
    </div>
  );
}
