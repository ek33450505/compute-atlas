import { describe, it, expect } from "vitest";

import type { AdminDatasetGrant } from "@/lib/dataset-admin";
import { toListGrant, toQueueGrant } from "./grant-views";

const full: AdminDatasetGrant = {
  id: "g1",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  email: "ada@example.org",
  name: "Ada Lovelace",
  organization: "Analytical Engines",
  role: "Reporter",
  category: "journalist",
  intendedUse: "Mapping water use.",
  links: ["https://example.org/profile"],
  status: "active",
  verifiedAt: new Date("2026-11-01T10:05:00Z"),
  approvedAt: new Date("2026-11-02T00:00:00Z"),
  reviewedAt: new Date("2026-11-02T00:00:00Z"),
  reviewNote: "internal",
  rejectionNote: "to requester",
  revokedAt: null,
  revokeReason: null,
  expiresAt: new Date("2027-11-02T00:00:00Z"),
  renewalRequestedAt: null,
  lastDownloadAt: null,
  downloadCount: 3,
  tier: "free",
  paidThrough: null,
  subscriptionLinked: false,
  live: true,
  renewalPending: false,
};

describe("toQueueGrant", () => {
  it("keeps exactly the fields the review queue shows or branches on", () => {
    expect(Object.keys(toQueueGrant(full)).sort()).toEqual([
      "category",
      "createdAt",
      "email",
      "expiresAt",
      "id",
      "intendedUse",
      "links",
      "live",
      "name",
      "organization",
      "renewalPending",
      "renewalRequestedAt",
      "role",
      "status",
    ]);
  });

  it("copies the values and returns a new object", () => {
    const view = toQueueGrant(full);
    expect(view).not.toBe(full);
    expect(view).toMatchObject({ id: "g1", name: "Ada Lovelace", email: "ada@example.org", live: true });
  });

  it("drops fields a future column would add", () => {
    const withExtra = { ...full, somethingSecret: "x" } as AdminDatasetGrant;
    expect(Object.keys(toQueueGrant(withExtra))).not.toContain("somethingSecret");
    expect(Object.keys(toListGrant(withExtra))).not.toContain("somethingSecret");
  });
});

describe("toListGrant", () => {
  it("keeps exactly the fields the grants list shows or branches on", () => {
    expect(Object.keys(toListGrant(full)).sort()).toEqual([
      "approvedAt",
      "createdAt",
      "downloadCount",
      "email",
      "expiresAt",
      "id",
      "lastDownloadAt",
      "live",
      "name",
      "organization",
      "paidThrough",
      "rejectionNote",
      "renewalPending",
      "renewalRequestedAt",
      "revokeReason",
      "revokedAt",
      "reviewNote",
      "status",
      "subscriptionLinked",
      "tier",
    ].sort());
  });

  it("leaves out the requester-typed fields the list never shows", () => {
    const keys = Object.keys(toListGrant(full));
    for (const key of ["role", "category", "intendedUse", "links", "verifiedAt", "reviewedAt"]) {
      expect(keys).not.toContain(key);
    }
  });

  it("copies the values and returns a new object", () => {
    const view = toListGrant(full);
    expect(view).not.toBe(full);
    expect(view).toMatchObject({ id: "g1", reviewNote: "internal", downloadCount: 3 });
  });
});
