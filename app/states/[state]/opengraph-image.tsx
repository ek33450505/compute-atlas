import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";
import { getStateSummaryCached } from "@/lib/data";
import { formatPower } from "@/lib/format";
import { stateNameFromCode, stateCodeFromSlug } from "@/lib/us-states";
import {
  AtlasMark,
  INK,
  MUTED_INK,
  OgFrame,
  loadFrauncesFont,
  renderOgFallbackCard,
} from "@/lib/og-theme";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/states/[state]/page.tsx) prerenders every
// tracked state at build time; doing the same for this image route would add
// a render per state to every production build. Deliberately on-demand.
export const revalidate = 86400;

export const alt = `${siteConfig.name} — state profile`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OGImage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);
  const summary = code ? await getStateSummaryCached(code) : null;
  const fraunces = loadFrauncesFont();

  // Bad or stale state code: never throw from an image route — a 500 here
  // breaks link unfurling for crawlers. Fall back to a generic site card
  // instead.
  if (!code || !summary) {
    return renderOgFallbackCard(fraunces, siteConfig, size);
  }

  const stateName = stateNameFromCode(code) ?? code;

  return new ImageResponse(
    (
      <OgFrame justifyContent="space-between">
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
      </OgFrame>
    ),
    {
      ...size,
      fonts: [{ name: "Fraunces", data: fraunces, weight: 600, style: "normal" }],
    }
  );
}
