import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getStakeholders, getStakeholderBySlug, getFacilitiesByStakeholder } from "@/lib/data";
import { CollectionPage } from "@/components/collection/collection-page";
import { formatStakeholderRole } from "../format-role";

export const revalidate = 3600;

export async function generateStaticParams() {
  const people = await getStakeholders();
  return people.map((p) => ({ person: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ person: string }>;
}): Promise<Metadata> {
  const { person: slug } = await params;
  const name = await getStakeholderBySlug(slug);
  if (!name) {
    return { title: "Stakeholder not found" };
  }

  const facilities = await getFacilitiesByStakeholder(name);
  return {
    title: `${name} — facilities`,
    description: `${facilities.length} tracked facilit${facilities.length === 1 ? "y" : "ies"} where ${name} has a documented, source-cited stake.`,
    alternates: { canonical: `/stakeholders/${slug}` },
  };
}

/**
 * /stakeholders/[person] — per-person hub. Static server component,
 * generated at build time for every tracked stakeholder via
 * generateStaticParams. Renders through the shared CollectionPage primitive
 * (masthead + stat row + facility grid), mirroring /metros/[metro] and
 * /status/[status]. Unknown slugs 404 rather than rendering empty — see PR
 * #180, which fixed exactly this class of soft-404 bug.
 */
export default async function StakeholderPage({
  params,
}: {
  params: Promise<{ person: string }>;
}) {
  const { person: slug } = await params;
  const name = await getStakeholderBySlug(slug);
  if (!name) {
    notFound();
  }

  const facilities = await getFacilitiesByStakeholder(name);
  if (facilities.length === 0) {
    notFound();
  }

  const people = await getStakeholders();
  const summary = people.find((p) => p.slug === slug);
  const roles = summary?.roles ?? [];
  const states = summary?.states ?? [];
  const roleList = roles.map(formatStakeholderRole).join(", ");

  return (
    <CollectionPage
      title={name}
      intro={
        <>
          <p>
            Compute Atlas tracks {facilities.length} facilit
            {facilities.length === 1 ? "y" : "ies"} with a documented,
            source-cited stake held by {name}
            {roleList ? ` — ${roleList}` : ""}.
          </p>
          <p>
            A person is listed against a facility only where a cited source
            ties them to that specific site, not merely to its operator.
          </p>
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "Stakeholders", href: "/stakeholders" },
        { label: name },
      ]}
      statRow={[
        { label: "Facilities", value: String(facilities.length) },
        { label: "States", value: String(states.length) },
      ]}
      facilities={facilities}
      emptyMessage={`No facilities are on file yet for ${name}.`}
    />
  );
}
