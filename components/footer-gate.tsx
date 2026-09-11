"use client";

import { usePathname } from "next/navigation";

// -----------------------------------------------------------------------------
// Immersive full-bleed routes size their content to exactly 100dvh (header +
// content, no footer). Rendering the global SiteFooter on these routes pushes
// the document past one viewport, causing an unwanted page scroll and clipping
// overlay panels. FooterGate hides its children (the footer) on those routes.
//
// `/embed/*` routes are chrome-free entirely — no site nav, no site footer —
// since they're rendered inside a third-party <iframe> with no room for
// either. Unlike FULL_BLEED_ROUTES (exact match on one known path),
// `/embed/*` covers a whole subtree of dynamic routes (e.g.
// `/embed/states/texas`), so it needs prefix matching rather than an exact
// list entry. HeaderGate below shares that same prefix check, since both
// gates need to agree on what counts as "an embed route."
// -----------------------------------------------------------------------------
const FULL_BLEED_ROUTES = ["/map"];
const EMBED_ROUTE_PREFIX = "/embed";

/**
 * Exported so `FacilityMap` (components/map/facility-map.tsx) can derive its
 * own `linksOpenInNewTab` frame-escape default from the SAME route check
 * HeaderGate/FooterGate use, instead of carrying a second, independently
 * maintained copy of "what counts as an embed route" that could silently
 * drift from this one (e.g. a new `/embed/*` subtree added here but not
 * mirrored there).
 */
export function isEmbedRoute(pathname: string): boolean {
  return pathname === EMBED_ROUTE_PREFIX || pathname.startsWith(`${EMBED_ROUTE_PREFIX}/`);
}

/** Suppresses the global SiteFooter on full-bleed map routes and every `/embed/*` route. */
export function FooterGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (FULL_BLEED_ROUTES.includes(pathname) || isEmbedRoute(pathname)) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Suppresses the global SiteHeader on every `/embed/*` route. Unlike
 * FooterGate, `/map` keeps its header — Explorer's map-mode shell measures
 * the real header height and subtracts it from 100dvh, so the header must
 * stay mounted there. Only `/embed/*` goes fully chrome-free (no header,
 * no footer) since those pages are meant to fill a third-party <iframe>
 * with nothing but the map and its attribution.
 */
export function HeaderGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (isEmbedRoute(pathname)) {
    return null;
  }

  return <>{children}</>;
}
