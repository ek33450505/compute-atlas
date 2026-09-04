import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CSSProperties, ReactNode } from "react";

// Atlas palette — CSS vars are not available in ImageResponse; hardcoded from
// app/globals.css :root. Shared by every next/og route (og-image + apple-icon).
export const PARCHMENT = "#F5F1E6";
export const INK = "#2B2721";
export const MUTED_INK = "#5C5344";
export const PRIMARY_GREEN = "#3F5B43";
export const HAIRLINE = "#CDBFA0";

/** Small graticule wordmark, reused at several sizes across the og-image and apple-icon routes. */
export function AtlasMark({ dim }: { dim: number }) {
  return (
    <svg width={dim} height={dim} viewBox="0 0 24 24" style={{ display: "flex", flexShrink: 0 }}>
      <rect x="7" y="2.4" width="14.6" height="14.6" rx="0.4" fill="none" stroke={PRIMARY_GREEN} strokeWidth="1.2" opacity={0.45} />
      <line x1="9.7" y1="7" x2="9.7" y2="21.6" stroke={PRIMARY_GREEN} strokeWidth="0.9" opacity={0.28} />
      <line x1="2.4" y1="14.3" x2="17" y2="14.3" stroke={PRIMARY_GREEN} strokeWidth="0.9" opacity={0.28} />
      <rect x="2.4" y="7" width="14.6" height="14.6" rx="0.4" fill="none" stroke={PRIMARY_GREEN} strokeWidth="1.85" />
      <rect x="7.9" y="12.5" width="3.6" height="3.6" fill={PRIMARY_GREEN} />
    </svg>
  );
}

/**
 * Neatline frame — 1px hairline border inset ~28px; all og-image content sits
 * inside. `justifyContent`/`gap` are the two axes that vary across call sites
 * ("space-between" for the three main renders, "center" + gap 18 for the two
 * generic-site fallbacks).
 */
export function OgFrame({
  justifyContent,
  gap,
  children,
}: {
  justifyContent: CSSProperties["justifyContent"];
  gap?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: PARCHMENT,
        padding: 28,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: HAIRLINE,
          padding: "40px 52px",
          justifyContent,
          ...(gap !== undefined ? { gap } : {}),
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Fraunces-72pt-SemiBold.ttf is vendored in public/fonts/.
export function loadFrauncesFont() {
  return readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf"));
}

/**
 * Generic site card — the fallback rendered by the dynamic og-image routes
 * ([slug] and [state]) when the requested record can't be resolved. Never
 * throw from an image route: a 500 here breaks link unfurling for crawlers.
 * Takes `site`/`size` as params rather than importing `@/lib/site` directly —
 * this module stays free of app-specific data dependencies since it gets
 * bundled into every og-image/apple-icon route.
 */
export function renderOgFallbackCard(
  fraunces: Buffer,
  site: { name: string; tagline: string },
  size: { width: number; height: number }
) {
  return new ImageResponse(
    (
      <OgFrame justifyContent="center" gap={18}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <AtlasMark dim={64} />
          <span
            style={{
              fontSize: 76,
              fontWeight: 600,
              color: INK,
              letterSpacing: "-1.5px",
              lineHeight: 1,
              fontFamily: "Fraunces",
            }}
          >
            {site.name}
          </span>
        </div>
        <div style={{ fontSize: 28, color: MUTED_INK, fontWeight: 400 }}>{site.tagline}</div>
      </OgFrame>
    ),
    {
      ...size,
      fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
    }
  );
}
