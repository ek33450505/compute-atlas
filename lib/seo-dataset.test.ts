import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";
import { describeFacilityJsonLdSweep } from "./test-fixtures/facility-jsonld-sweep";

/**
 * Cross-route validation of the facility JSON-LD against the committed fixture
 * (tests/fixtures, ~60 records). The same sweep runs against the REAL dataset in
 * seo-dataset.dataset.test.ts (DATASET=real).
 *
 * lib/seo.test.ts unit-tests the builder; this asserts the builder actually
 * produces sound structured data for every record. The distinction
 * matters: a builder that is correct on a hand-written case and a route that
 * renders it are each correct alone, which is precisely how the title/H1 drift
 * reached 203 of 636 pages before anything compared the two halves.
 */
describeFacilityJsonLdSweep(facilitiesRaw as unknown as Facility[], 20, "fixture");
