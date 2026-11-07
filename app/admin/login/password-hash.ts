import { pbkdf2Sync } from "node:crypto";

/**
 * PBKDF2 used by the admin password check. Lives outside `actions.ts` (a
 * "use server" file may only export async functions) so tests can observe how
 * many derivations a login request costs.
 */
export function derivePasswordHash(secret: string, salt: string): Buffer {
  return pbkdf2Sync(secret, salt, 210_000, 32, "sha256");
}
