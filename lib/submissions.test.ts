import { describe, it, expect } from "vitest";
import { submissionInputSchema } from "./submissions";

const provenance = {
  sources: ["https://example.com/press-release"],
  discoveredBy: "manual",
};

describe("submissionInputSchema", () => {
  it("accepts a valid create submission", () => {
    const result = submissionInputSchema.safeParse({
      kind: "create",
      payload: { name: "Example Facility" },
      provenance,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid update submission with a targetFacilityId", () => {
    const result = submissionInputSchema.safeParse({
      kind: "update",
      targetFacilityId: "some-facility-id",
      payload: { status: "operational" },
      provenance,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an update submission missing targetFacilityId", () => {
    const result = submissionInputSchema.safeParse({
      kind: "update",
      payload: { status: "operational" },
      provenance,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid status_update submission with a targetFacilityId", () => {
    const result = submissionInputSchema.safeParse({
      kind: "status_update",
      targetFacilityId: "some-facility-id",
      payload: { status: "operational", date: "2026-07-16", sources: [] },
      provenance,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a status_update submission missing targetFacilityId", () => {
    const result = submissionInputSchema.safeParse({
      kind: "status_update",
      payload: { status: "operational", date: "2026-07-16", sources: [] },
      provenance,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a submission with an empty sources array", () => {
    const result = submissionInputSchema.safeParse({
      kind: "create",
      payload: { name: "Example Facility" },
      provenance: { ...provenance, sources: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a submission missing discoveredBy", () => {
    const result = submissionInputSchema.safeParse({
      kind: "create",
      payload: { name: "Example Facility" },
      provenance: { sources: ["https://example.com"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid kind", () => {
    const result = submissionInputSchema.safeParse({
      kind: "delete",
      payload: { name: "Example Facility" },
      provenance,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload that is not an object", () => {
    const result = submissionInputSchema.safeParse({
      kind: "create",
      payload: "not an object",
      provenance,
    });
    expect(result.success).toBe(false);
  });
});
