import { describe, it, expect } from "vitest";
import { buildFacilityJsonLd, facilityJsonLdString } from "@/lib/seo";
import type { Facility } from "@/lib/schema";

/**
 * The whole-dataset JSON-LD sweep, shared by lib/seo-dataset.test.ts (runs over
 * the committed fixture in the default run) and lib/seo-dataset.dataset.test.ts
 * (runs over the real data/facilities.json under DATASET=real). One definition,
 * so the two can never assert different things.
 */
export function describeFacilityJsonLdSweep(
  facilities: Facility[],
  minRecords: number,
  scope: string
): void {
  describe(`facility JSON-LD across the whole dataset (${scope})`, () => {
    it("has a non-empty dataset to check (guards a silently empty import)", () => {
      // Without this, every assertion below would vacuously pass on [].
      expect(facilities.length).toBeGreaterThan(minRecords);
    });

    it("serializes every facility to parseable JSON-LD", () => {
      const failures: string[] = [];
      for (const f of facilities) {
        try {
          JSON.parse(facilityJsonLdString(f).replace(/\\u003c/g, "<"));
        } catch (e) {
          failures.push(`${f.id}: ${(e as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it("never emits a PropertyValue with an empty, null or 'undefined' value", () => {
      // A published fact that reads "undefined" is worse than an absent one:
      // it is a claim the dataset never made. Absent must mean absent.
      const bad: string[] = [];
      for (const f of facilities) {
        for (const p of buildFacilityJsonLd(f).additionalProperty ?? []) {
          const v = p.value;
          if (
            v === undefined ||
            v === null ||
            v === "" ||
            String(v).toLowerCase().includes("undefined")
          ) {
            bad.push(`${f.id}: ${p.name}=${String(v)}`);
          }
          if (!p.name) bad.push(`${f.id}: nameless property`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("gives every facility the operator, status and type it publishes", () => {
      const missing: string[] = [];
      for (const f of facilities) {
        const names = (buildFacilityJsonLd(f).additionalProperty ?? []).map(
          (p) => p.name
        );
        for (const required of ["Operator", "Status", "Facility type"]) {
          if (!names.includes(required)) missing.push(`${f.id}: ${required}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it("tags every capacity value with the megawatt unit code", () => {
      const untagged: string[] = [];
      for (const f of facilities) {
        for (const p of buildFacilityJsonLd(f).additionalProperty ?? []) {
          if (!p.name.endsWith("capacity")) continue;
          if (typeof p.value !== "number" || p.unitCode !== "MAW") {
            untagged.push(`${f.id}: ${p.name}`);
          }
        }
      }
      expect(untagged).toEqual([]);
    });

    it("keeps geo coordinates inside the emitted Place", () => {
      const broken = facilities.filter((f) => {
        const ld = buildFacilityJsonLd(f);
        return (
          typeof ld.geo.latitude !== "number" ||
          typeof ld.geo.longitude !== "number" ||
          ld["@type"] !== "Place"
        );
      });
      expect(broken.map((f) => f.id)).toEqual([]);
    });
  });
}
