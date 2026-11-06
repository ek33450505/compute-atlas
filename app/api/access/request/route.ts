import { notAvailable, corsPreflight } from "@/lib/api-response";

/**
 * Access requests are not accepted: always a no-store 403, with no body
 * parsing, no database access (so no intake-attempt write) and no email.
 */
export function POST() {
  return notAvailable();
}

// `public-write`: anonymous POST only; the path exports no PATCH/DELETE.
export function OPTIONS() {
  return corsPreflight("public-write");
}
