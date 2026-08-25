import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteConfig } from "@/lib/site";
import { getStateSummaryCached } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { stateNameFromCode, stateCodeFromSlug } from "@/lib/us-states";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/states/[state]/page.tsx) prerenders every
// tracked state at build time; doing the same for this image route would add
// a render per state to every production build. Deliberately on-demand.
export const revalidate = 86400;

// Atlas palette — CSS vars are not available in ImageResponse; hardcoded from
// app/globals.css :root (mirrors app/opengraph-image.tsx — duplicated rather
// than imported, since each `opengraph-image.tsx` must be a self-contained
// route module).
const PARCHMENT = "#F5F1E6";
const INK = "#2B2721";
const MUTED_INK = "#5C5344";
const PRIMARY_GREEN = "#3F5B43";
const HAIRLINE = "#CDBFA0";

export const alt = `${siteConfig.name} — state profile`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Fraunces-72pt-SemiBold.ttf is vendored in public/fonts/ — loaded via
// readFileSync below, same as app/opengraph-image.tsx.

/** Small graticule wordmark, reused at two sizes (fallback card vs. footer). */
function AtlasMark({ dim }: { dim: number }) {
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

export default async function OGImage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);
  const summary = code ? await getStateSummaryCached(code) : null;
  const fraunces = readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf"));

  // Bad or stale slug: never throw from an image route — a 500 here breaks
  // link unfurling for crawlers. Fall back to a generic site card instead.
  if (!code || !summary) {
    return new ImageResponse(
      (
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
              justifyContent: "center",
              gap: 18,
            }}
          >
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
                {siteConfig.name}
              </span>
            </div>
            <div style={{ fontSize: 28, color: MUTED_INK, fontWeight: 400 }}>
              {siteConfig.tagline}
            </div>
          </div>
        </div>
      ),
      {
        ...size,
        fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
      }
    );
  }

  const stateName = stateNameFromCode(code) ?? code;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: PARCHMENT,
          padding: 28,
        }}
      >
        {/* Neatline frame — 1px hairline border inset ~28px; all content sits inside */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: HAIRLINE,
            padding: "40px 52px",
            justifyContent: "space-between",
          }}
        >
          {/* Overline */}
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              color: MUTED_INK,
              letterSpacing: "3.6px",
            }}
          >
            STATE PROFILE
          </div>

          {/* Headline + stat blocks */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <span
              style={{
                fontSize: 64,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-1.5px",
                lineHeight: 1.05,
                fontFamily: "Fraunces",
                maxWidth: 1040,
              }}
            >
              {stateName}
            </span>
            <div style={{ display: "flex", gap: 48 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontFamily: "monospace", fontSize: 40, color: INK }}>
                  {summary.count}
                </span>
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: 16,
                    color: MUTED_INK,
                    letterSpacing: "1.6px",
                  }}
                >
                  SITES
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontFamily: "monospace", fontSize: 40, color: INK }}>
                  {formatPower(summary.operationalMw)}
                </span>
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: 16,
                    color: MUTED_INK,
                    letterSpacing: "1.6px",
                  }}
                >
                  OPERATIONAL
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontFamily: "monospace", fontSize: 40, color: INK }}>
                  {formatPower(summary.plannedMw)}
                </span>
                <span
                  style={{
                    fontFamily: "monospace",
                    fontSize: 16,
                    color: MUTED_INK,
                    letterSpacing: "1.6px",
                  }}
                >
                  PLANNED PIPELINE
                </span>
              </div>
            </div>
          </div>

          {/* Wordmark + domain */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <AtlasMark dim={40} />
              <span
                style={{
                  fontSize: 30,
                  fontWeight: 600,
                  color: INK,
                  letterSpacing: "-0.5px",
                  fontFamily: "Fraunces",
                }}
              >
                {siteConfig.name}
              </span>
            </div>
            <div style={{ fontSize: 16, color: MUTED_INK }}>
              {siteConfig.url.replace(/^https?:\/\//, "")}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
    }
  );
}
