import { afterEach, describe, expect, it } from "vitest";

import { EDGE_SECRET_HEADER, hasValidEdgeSecret } from "@/lib/edge-secret";

const ORIGINAL = process.env.EDGE_SHARED_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EDGE_SHARED_SECRET;
  else process.env.EDGE_SHARED_SECRET = ORIGINAL;
});

describe("hasValidEdgeSecret", () => {
  it("accepts a matching header", () => {
    process.env.EDGE_SHARED_SECRET = "s3cret";
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "s3cret" }))).toBe(true);
  });

  it("rejects a missing, empty or wrong header, including a different length", () => {
    process.env.EDGE_SHARED_SECRET = "s3cret";
    expect(hasValidEdgeSecret(new Headers())).toBe(false);
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "" }))).toBe(false);
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "wrong!" }))).toBe(false);
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "s3" }))).toBe(false);
  });

  it("fails closed when the secret is unset or empty, even for an empty header", () => {
    delete process.env.EDGE_SHARED_SECRET;
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "anything" }))).toBe(false);
    process.env.EDGE_SHARED_SECRET = "";
    expect(hasValidEdgeSecret(new Headers({ [EDGE_SECRET_HEADER]: "" }))).toBe(false);
  });
});
