// Regression coverage for the server/client module-boundary bug fixed by
// extracting `emptyFacilityFormState`/`facilityToFormState` out of
// `facility-form.tsx` (a "use client" file) into this standalone module.
//
// Before the fix, these were the ONLY exports of a "use client" file, so
// every export became a client-only reference from Next.js's perspective —
// even though the functions themselves are pure with no hooks or browser
// APIs. Server components (`new/page.tsx`, `[id]/page.tsx`) calling them
// directly triggered: "Attempted to call emptyFacilityFormState() from the
// server but emptyFacilityFormState is on the client."
//
// This suite pins the two source-level properties that make a module
// server-callable in Next.js's App Router: (1) no "use client"/"use server"
// directive as its first statement, and (2) no import of `react` (the
// telltale of hook/component code that would force client-only status).
// Global `vitest.setup.ts` assumes jsdom's `window` global, so this file
// intentionally stays on the project's default jsdom environment rather
// than requesting Vitest's `node` environment (which would skip that setup
// file and crash on `window.matchMedia`) — the source-inspection assertions
// below do not depend on which DOM environment the test runs under. Combined
// with `npm run build`'s own prerender check (the authoritative gate for
// this bug class), this test would have failed on the pre-fix code, where
// `facility-form.tsx` line 1 was `"use client"` and these functions had no
// existence outside that file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { emptyFacilityFormState, facilityToFormState } from "./facility-form-state";
import type { Facility } from "@/lib/schema";

// `vitest.config.ts` aliases "@" to the repo root, so resolve relative to
// process.cwd() (the repo root Vitest runs from) rather than import.meta.url
// (unreliable under this project's Turbopack-flavored transform pipeline).
const SOURCE_PATH = path.resolve(
  process.cwd(),
  "app/admin/facilities/facility-form-state.ts",
);

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, state: "TX", city: "Austin", precision: "exact" },
    capacityMw: { operational: 100, planned: 200 },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com",
        label: "Press release",
        retrievedAt: "2026-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2026-01-01",
    facilityType: "data_center",
    ...overrides,
  } as Facility;
}

describe("facility-form-state module boundary (regression)", () => {
  it("has no 'use client' or 'use server' directive", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const firstStatement = source.trimStart().split("\n")[0];
    expect(firstStatement).not.toMatch(/^["']use client["'];?$/);
    expect(firstStatement).not.toMatch(/^["']use server["'];?$/);
  });

  it("never imports 'react' — a server component must be able to import it directly", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/from ["']react["']/);
  });

  it("is callable exactly the way the server pages call it to build initialState", () => {
    // `new/page.tsx` calls emptyFacilityFormState() directly to build the
    // `initialState` prop it passes to <FacilityForm mode="create">; a
    // similar call is impossible from a "use client" file's export.
    const empty = emptyFacilityFormState();
    expect(empty.id).toBe("");
    expect(empty.facilityType).toBe("data_center");

    // `[id]/page.tsx` calls facilityToFormState(facility) directly for the
    // "edit" mode initialState.
    const loaded = facilityToFormState(makeFacility({ id: "abc-123" }));
    expect(loaded.id).toBe("abc-123");
    expect(loaded.name).toBe("Test Facility");
  });
});
