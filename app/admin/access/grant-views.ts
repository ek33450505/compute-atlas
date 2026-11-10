import type { AdminDatasetGrant } from "@/lib/dataset-admin";

/**
 * Plain module on purpose (no "use client"/"use server"): the server page calls these mappers and
 * hands the results to client components, so only the listed fields ride the RSC payload. Each
 * mapper builds a NEW object key by key, never a spread-then-delete, so a column added to
 * AdminDatasetGrant later reaches the client only when a component is changed to show it.
 */

/** Exactly the fields AccessQueue renders or needs for logic. */
export type QueueGrant = Pick<
  AdminDatasetGrant,
  | "id"
  | "name"
  | "email"
  | "organization"
  | "role"
  | "category"
  | "intendedUse"
  | "links"
  | "status"
  | "createdAt"
  | "expiresAt"
  | "renewalRequestedAt"
  | "live"
  | "renewalPending"
>;

/** Exactly the fields GrantsList renders or needs for logic. */
export type ListGrant = Pick<
  AdminDatasetGrant,
  | "id"
  | "name"
  | "email"
  | "organization"
  | "status"
  | "createdAt"
  | "approvedAt"
  | "expiresAt"
  | "renewalRequestedAt"
  | "revokedAt"
  | "lastDownloadAt"
  | "downloadCount"
  | "tier"
  | "paidThrough"
  | "subscriptionLinked"
  | "reviewNote"
  | "rejectionNote"
  | "revokeReason"
  | "live"
  | "renewalPending"
>;

export function toQueueGrant(grant: AdminDatasetGrant): QueueGrant {
  return {
    id: grant.id,
    name: grant.name,
    email: grant.email,
    organization: grant.organization,
    role: grant.role,
    category: grant.category,
    intendedUse: grant.intendedUse,
    links: grant.links,
    status: grant.status,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    renewalRequestedAt: grant.renewalRequestedAt,
    live: grant.live,
    renewalPending: grant.renewalPending,
  };
}

export function toListGrant(grant: AdminDatasetGrant): ListGrant {
  return {
    id: grant.id,
    name: grant.name,
    email: grant.email,
    organization: grant.organization,
    status: grant.status,
    createdAt: grant.createdAt,
    approvedAt: grant.approvedAt,
    expiresAt: grant.expiresAt,
    renewalRequestedAt: grant.renewalRequestedAt,
    revokedAt: grant.revokedAt,
    lastDownloadAt: grant.lastDownloadAt,
    downloadCount: grant.downloadCount,
    tier: grant.tier,
    paidThrough: grant.paidThrough,
    subscriptionLinked: grant.subscriptionLinked,
    reviewNote: grant.reviewNote,
    rejectionNote: grant.rejectionNote,
    revokeReason: grant.revokeReason,
    live: grant.live,
    renewalPending: grant.renewalPending,
  };
}
