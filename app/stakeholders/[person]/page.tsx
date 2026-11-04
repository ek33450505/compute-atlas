import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import {
  getStakeholders,
  getStakeholderBySlug,
  getFacilitiesByStakeholder,
  type StakeholderSummary,
} from "@/lib/data";
import { OPERATOR_OWNER_ROLE_LABELS } from "@/lib/operator-ownership";
import { statesStat } from "@/lib/us-states";
import { CollectionPage } from "@/components/collection/collection-page";
import { OperatorOwnerDetails } from "@/components/operator-owner-details";
import { SectionHeading } from "@/components/section-heading";
import { formatStakeholderRole } from "../format-role";

export const revalidate = 86400;

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
  const summary = (await getStakeholders()).find((p) => p.slug === slug);
  const operatorCount = summary?.viaOperators.length ?? 0;
  const description =
    facilities.length > 0
      ? `${facilities.length} tracked facilit${facilities.length === 1 ? "y" : "ies"} where ${name} has a documented, source-cited stake.`
      : `${name} holds a documented, source-cited stake in the operating company of ${operatorCount} tracked operator${operatorCount === 1 ? "" : "s"}.`;
  return {
    title: `${name} — stakeholder profile`,
    description,
    alternates: { canonical: `/stakeholders/${slug}` },
  };
}

/** "A", "A and B", "A, B and C" — for the operator names in the intro. */
function joinNames(names: string[]): string {
  return new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(names);
}

function ViaOperatorSection({ via }: { via: StakeholderSummary["viaOperators"] }) {
  return (
    <section aria-labelledby="via-operator-heading" className="space-y-6 border-t border-border pt-8">
      <SectionHeading kicker="Ownership" id="via-operator-heading" title="Through operator ownership" />
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        These stakes are held in the operating company, not documented for any
        one site. They are listed apart from the site-level facilities below and
        are not counted as site-level stakes.
      </p>
      <ul className="divide-y divide-border">
        {via.map(({ operator, slug: operatorPath, facilityCount, owner }) => (
          <li key={operator} className="space-y-1 py-4 text-sm">
            <span className="flex flex-wrap items-center gap-x-1">
              {facilityCount > 0 ? (
                <Link
                  href={`/operators/${operatorPath}`}
                  className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {operator}
                </Link>
              ) : (
                <span className="font-medium text-foreground">{operator}</span>
              )}
              {` · ${OPERATOR_OWNER_ROLE_LABELS[owner.role]} · ${facilityCount} tracked facilit${facilityCount === 1 ? "y" : "ies"}`}
            </span>
            <OperatorOwnerDetails owner={owner} />
          </li>
        ))}
      </ul>
    </section>
  );
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
  const people = await getStakeholders();
  const summary = people.find((p) => p.slug === slug);
  // A known name always has a summary; an owner with no site-level facility
  // still renders (via its operators) rather than 404ing.
  if (!summary || (facilities.length === 0 && summary.viaOperators.length === 0)) {
    notFound();
  }

  const via = summary.viaOperators;
  const hasSites = facilities.length > 0;
  const statesTile = statesStat(summary.states);
  // Roles held at the listed SITES, not the union with operator-level roles.
  const siteRoleList = [
    ...new Set(
      facilities.flatMap((f) =>
        (f.stakeholders ?? []).filter((s) => s.name === name).map((s) => s.role)
      )
    ),
  ]
    .sort()
    .map(formatStakeholderRole)
    .join(", ");

  return (
    <CollectionPage
      title={name}
      intro={
        <>
          <p>
            {facilities.length > 0
              ? `Compute Atlas tracks ${facilities.length} facilit${facilities.length === 1 ? "y" : "ies"} with a documented, source-cited stake held by ${name}${siteRoleList ? ` — ${siteRoleList}` : ""}.`
              : `${name} has no stake documented for a specific site on file.`}
            {via.length > 0
              ? ` ${name} also holds a documented, source-cited stake in the operating company of ${joinNames(via.map((v) => v.operator))}.`
              : ""}
          </p>
          <p>
            A person or organization is listed against a facility only where a
            cited source ties them to that specific site, not merely to its operator.
            {via.length > 0
              ? " Stakes held through an operator are shown separately and are not counted as site-level stakes."
              : ""}
          </p>
        </>
      }
      crumbs={[
        { label: "Explore", href: "/explore" },
        { label: "Stakeholders", href: "/stakeholders" },
        { label: name },
      ]}
      // `states` is site-level, so an owner with no site-level facility shows
      // an Operators tile instead of a meaningless "0 States".
      statRow={[
        ...(hasSites ? [{ label: "Facilities", value: String(facilities.length) }] : []),
        ...(via.length > 0 ? [{ label: "Operators", value: String(via.length) }] : []),
        ...(hasSites ? [{ ...statesTile, value: String(statesTile.value) }] : []),
      ]}
      facilities={facilities}
      beforeGrid={via.length > 0 ? <ViaOperatorSection via={via} /> : null}
      emptyMessage={
        via.length > 0
          ? `No site-level stakes are on file for ${name}; see the operator ownership above.`
          : `No facilities are on file yet for ${name}.`
      }
    />
  );
}
