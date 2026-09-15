import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";
import { buildFacilityJsonLd, facilityJsonLdString } from "./seo";
import type { Facility } from "@/lib/schema";

/**
 * Cross-route validation of the facility JSON-LD against the REAL dataset,
 * not a fixture.
 *
 * lib/seo.test.ts unit-tests the builder; this asserts the builder actually
 * produces sound structured data for every published record. The distinction
 * matters: a builder that is correct on a fixture and a route that renders it
 * are each correct alone, which is precisely how the title/H1 drift reached
 * 203 of 636 pages before anything compared the two halves.
 *
 * Sibling of lib/siting-context.test.ts, which asserts the same class of
 * whole-dataset invariant against data/siting-context.json.
 */
const facilities = facilitiesRaw as unknown as Facility[];

describe("facility JSON-LD across the whole dataset", () => {
  it("has a non-empty dataset to check (guards a silently empty import)", () => {
    // Without this, every assertion below would vacuously pass on [].
    expect(facilities.length).toBeGreaterThan(1000);
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
