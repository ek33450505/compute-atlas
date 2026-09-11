import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getStates, getFacilitiesByStateCached } from "@/lib/data";
import { stateNameFromCode, stateSlugFromCode, stateCodeFromSlug } from "@/lib/us-states";
import { siteConfig } from "@/lib/site";
import { FacilityMap } from "@/components/map/facility-map-dynamic";
import { StatePanel } from "@/components/feedback/state-panel";

export const revalidate = false;

export async function generateStaticParams() {
  const codes = await getStates();
  return codes
    .map((code) => stateSlugFromCode(code))
    .filter((slug): slug is string => slug !== undefined)
    .map((slug) => ({ state: slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ state: string }>;
}): Promise<Metadata> {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);

  // Deliberately does NOT 404 here on a zero-facility state — unlike
  // /states/[state], which treats "no StateSummary" as not-found. An embed
  // handed to a newsroom must render an honest "not tracked yet" panel
  // instead, not a broken iframe (see the empty-state branch in the page
  // component below). So metadata only depends on whether the slug maps to
  // a real US state at all, not on whether it currently has data.
  if (!code) {
    return { title: "State not found", robots: { index: false, follow: false } };
  }

  const stateName = stateNameFromCode(code)!;

  return {
    title: `Data centers in ${stateName} — embed`,
    description: `Embeddable map of data centers tracked in ${stateName}.`,
    // Embed URLs are a rendering surface for third-party pages, not a
    // destination anyone should land on via search — the canonical,
    // indexable version of this content is the /states hub. Getting this
    // wrong would let a noindex-free embed compete with (and dilute) the
    // page the embed exists to send traffic to.
    robots: { index: false, follow: false },
  };
}

/**
 * /embed/states/[state] — chrome-free, iframe-embeddable map of one state's
 * facilities. No site header/footer (suppressed via HeaderGate/FooterGate in
 * app/layout.tsx), no FacilityMap "Tools" chrome (basemap switch, layer
 * overlays, etc. — see the `chrome` prop on FacilityMap). Sized to fill
 * exactly the iframe's own viewport via 100dvh, since there's no site header
 * left to subtract.
 *
 * The attribution bar at the bottom is NOT a FacilityMap feature and takes no
 * prop that could turn it off — it's hardcoded into this page precisely so
 * it can't be stripped by whatever embeds it. That backlink to the real
 * /states/<slug> hub is the entire commercial logic of offering this embed
 * at all.
 */
export default async function EmbedStatePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: slug } = await params;
  const code = stateCodeFromSlug(slug);
  if (!code) {
    notFound();
  }

  const stateName = stateNameFromCode(code)!;
  const facilities = await getFacilitiesByStateCached(code);
  const hubHref = `${siteConfig.url}/states/${slug}`;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {facilities.length > 0 ? (
        <section
          aria-label={`Map of data centers in ${stateName}`}
          className="relative min-h-0 flex-1"
        >
          <FacilityMap
            facilities={facilities}
            heightClass="h-full"
            chrome={false}
            surveyOnMount
            // isFiltered defaults to true, which is what we want here: this
            // state's facility list is a real, deliberately-scoped result
            // set (not "no filter active"), so the initial camera move
            // should fit bounds tightly around it rather than easing back
            // to the default CONUS view. See the isFiltered doc comment on
            // FacilityMapProps in facility-map.tsx.
            //
            // No linksOpenInNewTab prop here on purpose — it's no longer
            // needed. FacilityMap now derives the frame-escape itself from
            // usePathname() + isEmbedRoute() (shared with HeaderGate/
            // FooterGate), so every `/embed/*` route gets it automatically,
            // including this one — this comment is here so a future reader
            // doesn't mistake the missing prop for an accidental drop. See
            // the prop's doc comment in facility-map.tsx for the full threat
            // model and why the default now derives instead of requiring
            // every caller to remember to pass `true`.
          />
        </section>
      ) : (
        <div className="flex flex-1 items-center justify-center px-4">
          <StatePanel
            titleAs="p"
            eyebrow="No results yet"
            title={`No facilities tracked yet in ${stateName}`}
            description="Compute Atlas hasn't published a sourced data center record for this state yet."
          />
        </div>
      )}

      {/* Permanent attribution bar — see the component doc comment above. */}
      <footer className="flex shrink-0 items-center justify-center border-t border-border bg-background px-3 py-2">
        <a
          href={hubHref}
          target="_blank"
          rel="noopener"
          className="font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          Compute Atlas — data centers in {stateName}
        </a>
      </footer>
    </div>
  );
}
