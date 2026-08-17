import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteConfig } from "@/lib/site";
import { getFacilityByIdCached } from "@/lib/data";
import { getStatusMeta, type Status } from "@/lib/status";
import { FACILITY_TYPE_META } from "@/lib/facility-type";
import { stateNameFromCode } from "@/lib/us-states";

// Render on demand and cache for a day — do NOT add generateStaticParams here.
// The page this mirrors (app/facilities/[slug]/page.tsx) prerenders all 1000+
// facility slugs at build time; doing the same for this image route would add
// a render per facility to every production build. Deliberately on-demand.
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

// Parchment-tuned atlas status colors, keyed by status for a single
// facility's lookup (app/opengraph-image.tsx uses the same five hexes as an
// ordered array since it draws the full spectrum rather than one status).
const STATUS_COLOR: Record<Status, string> = {
  operational: "#005E90",
  under_construction: "#8F4108",
  permitted: "#036A4A",
  proposed: "#8A2661",
  cancelled: "#39414A",
};

export const alt = `${siteConfig.name} — facility profile`;
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
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const facility = await getFacilityByIdCached(slug);
  const fraunces = readFileSync(join(process.cwd(), "public/fonts/Fraunces-72pt-SemiBold.ttf"));

  // Bad or stale slug: never throw from an image route — a 500 here breaks
  // link unfurling for crawlers. Fall back to a generic site card instead.
  if (!facility) {
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

  const typeLabel = (
    FACILITY_TYPE_META[facility.facilityType]?.label ?? facility.facilityType
  ).toUpperCase();
  const stateName = (
    stateNameFromCode(facility.location.state) ?? facility.location.state
  ).toUpperCase();
  const statusMeta = getStatusMeta(facility.status);
  const statusColor = STATUS_COLOR[facility.status];

  // Mirrors the capacity formatting on the homepage's notable-sites cards
  // (app/page.tsx ~L189, L217-223): operational capacity wins over planned,
  // MW below 1000 else GW to one decimal.
  const cap = facility.capacityMw?.operational ?? facility.capacityMw?.planned ?? null;
  const capacityLabel =
    cap === null ? null : cap >= 1000 ? `${(cap / 1000).toFixed(1)} GW` : `${cap} MW`;

  // Operator names in this dataset are not all short handles — some are full
  // descriptive strings (e.g. "Multi-tenant carrier hotel (Digital Realty,
  // CoreSite, and other carrier/telecom tenants)"). Rendered raw, one of
  // those wraps to several lines and squeezes the status chip beside it until
  // the chip's own label is clipped mid-word. Satori's `text-overflow` support
  // is partial, so bound the string here rather than relying on CSS.
  const OPERATOR_MAX = 52;
  const operatorLabel =
    facility.operator.length > OPERATOR_MAX
      ? `${facility.operator.slice(0, OPERATOR_MAX - 1).trimEnd()}…`
      : facility.operator;

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
          {/* Overline: facility type + state */}
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              color: MUTED_INK,
              letterSpacing: "3.6px",
            }}
          >
            {/* Single interpolated string, NOT `{typeLabel} · {stateName}`:
                Satori throws "Expected <div> to have explicit display: flex
                ... if it has more than one child node" when JSX splits this
                into several text children. Keeping it one child avoids both
                that crash and the word-spacing changes display:flex would
                introduce. */}
            {`${typeLabel} · ${stateName}`}
          </div>

          {/* Headline + status chip + operator/capacity */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <span
              style={{
                fontSize: 50,
                fontWeight: 600,
                color: INK,
                letterSpacing: "-1px",
                lineHeight: 1.15,
                fontFamily: "Fraunces",
                maxWidth: 1040,
              }}
            >
              {facility.name}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div
                style={{
                  display: "flex",
                  fontFamily: "monospace",
                  fontSize: 18,
                  color: PARCHMENT,
                  backgroundColor: statusColor,
                  letterSpacing: "1.6px",
                  padding: "8px 16px",
                  borderRadius: 6,
                  /* Never let a long operator name squeeze the chip until its
                     own label clips mid-word — the chip is fixed-size, the
                     operator is the flexible element. */
                  flexShrink: 0,
                }}
              >
                {statusMeta.label.toUpperCase()}
              </div>
              <span style={{ fontSize: 26, color: MUTED_INK }}>{operatorLabel}</span>
              {capacityLabel && (
                <>
                  <span style={{ fontSize: 26, color: HAIRLINE }}>·</span>
                  <span style={{ fontSize: 26, color: MUTED_INK, fontFamily: "monospace" }}>
                    {capacityLabel}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Coordinate line + wordmark */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 20,
                color: MUTED_INK,
                letterSpacing: "2.4px",
              }}
            >
              {/* Single child, same Satori constraint as the overline above. */}
              {`${facility.location.lat.toFixed(3)}°N ${Math.abs(facility.location.lon).toFixed(3)}°W`}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <AtlasMark dim={36} />
              <span
                style={{
                  fontSize: 26,
                  fontWeight: 600,
                  color: INK,
                  letterSpacing: "-0.5px",
                  fontFamily: "Fraunces",
                }}
              >
                {siteConfig.name}
              </span>
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
