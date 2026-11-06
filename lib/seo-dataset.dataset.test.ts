import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";
import { describeFacilityJsonLdSweep } from "./test-fixtures/facility-jsonld-sweep";

/**
 * Cross-route validation of the facility JSON-LD against the REAL dataset
 * (DATASET=real). Sibling of lib/siting-context.dataset.test.ts, which asserts
 * the same class of whole-dataset invariant against data/siting-context.json.
 * The sweep itself is shared with the fixture run in seo-dataset.test.ts.
 */
describeFacilityJsonLdSweep(facilitiesRaw as unknown as Facility[], 1000, "real dataset");
