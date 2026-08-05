"use client";

import { usePathname } from "next/navigation";

// -----------------------------------------------------------------------------
// Immersive full-bleed routes size their content to exactly 100dvh (header +
// content, no footer). Rendering the global SiteFooter on these routes pushes
// the document past one viewport, causing an unwanted page scroll and clipping
// overlay panels. FooterGate hides its children (the footer) on those routes.
// -----------------------------------------------------------------------------
const FULL_BLEED_ROUTES = ["/map"];

export function FooterGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (FULL_BLEED_ROUTES.includes(pathname)) {
    return null;
  }

  return <>{children}</>;
}
