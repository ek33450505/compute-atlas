import type { Metadata } from "next";

import { siteConfig } from "@/lib/site";
import { Breadcrumb } from "@/components/breadcrumb";
import { GraticuleSurvey } from "@/components/home/graticule-survey";

export const metadata: Metadata = {
  title: "API",
  description:
    "The Compute Atlas API — a public, CORS-open JSON read API over the dataset, plus an admin write and provenance-staged submissions API for contributors.",
};

/** Shared style for inline `<code>` tokens (endpoints, headers, param names). */
const CODE = "rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground";

/** Shared style for method+path table cells. */
const METHOD_PATH = "font-mono text-sm text-foreground";

interface Endpoint {
  method: string;
  path: string;
  description: string;
}

const READ_ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/facilities",
    description:
      "All facilities. Optional filters: state, type, operator, status, q — each accepts a comma-separated list or repeated params; unrecognized tokens are ignored rather than rejected. Returns { count, facilities }.",
  },
  {
    method: "GET",
    path: "/api/facilities/{id}",
    description: "One facility by id. 404 if the id isn't found.",
  },
  {
    method: "GET",
    path: "/api/stats",
    description:
      "Aggregate dataset figures: { count, states, operationalMw, plannedMw, underConstructionMw }.",
  },
  {
    method: "GET",
    path: "/api/schema",
    description: "The JSON Schema of a facility record, derived from the underlying Zod schema.",
  },
];

const WRITE_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/facilities",
    description: "Create a facility. 201 on success, 400 on a schema-invalid body, 409 on a duplicate id.",
  },
  {
    method: "PATCH",
    path: "/api/facilities/{id}",
    description: "Partially update a facility. 200 on success, 400 on a schema-invalid body, 404 if the id isn't found.",
  },
  {
    method: "DELETE",
    path: "/api/facilities/{id}",
    description: "Delete a facility. 200 on success, 404 if the id isn't found.",
  },
];

const SUBMISSION_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/submissions",
    description:
      'Stage a candidate for review: { kind: "create" | "update", targetFacilityId?, payload, provenance }. targetFacilityId is required when kind is "update".',
  },
  {
    method: "GET",
    path: "/api/submissions?status=pending",
    description: "Admin-only. List staged submissions, optionally filtered by review status.",
  },
  {
    method: "POST",
    path: "/api/submissions/{id}/approve",
    description: "Validate a pending submission and promote it to a live facility.",
  },
  {
    method: "POST",
    path: "/api/submissions/{id}/reject",
    description: 'Reject a pending submission: { reason }.',
  },
];

function EndpointTable({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-2 pr-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Endpoint
            </th>
            <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={`${e.method} ${e.path}`} className="border-b border-border/60 align-top">
              <td className="whitespace-nowrap py-3 pr-4">
                <span className={METHOD_PATH}>
                  {e.method} {e.path}
                </span>
              </td>
              <td className="py-3 leading-relaxed text-muted-foreground">{e.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApiPage() {
  return (
    <div data-content-width="3xl" className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-16 space-y-12">
      <Breadcrumb items={[{ label: "Map", href: "/map" }, { label: "API" }]} />
      {/* ---- Masthead ---- */}
      <header className="relative">
        <GraticuleSurvey className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />
        <div className="relative space-y-4 pb-8">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">
            API reference · Edition 2026
          </p>
          <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            The atlas, as JSON.
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
            Compute Atlas exposes a small HTTP+JSON API over the open dataset.
            Reads are public and unauthenticated; the data returned carries
            the same{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Creative Commons Attribution 4.0 (CC-BY) license (opens in new tab)"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              CC-BY
            </a>{" "}
            license as the site.
          </p>
        </div>
        <div className="border-t border-border" />
      </header>

      {/* ---- Reading the data ---- */}
      <section aria-labelledby="reads-heading" className="space-y-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Reading the data
        </p>
        <h2 id="reads-heading" className="font-display text-2xl text-foreground">
          Public reads
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          No authentication is required, and every response carries an open
          CORS header (<code className={CODE}>Access-Control-Allow-Origin: *</code>)
          so the data can be fetched directly from the browser.
        </p>
        <EndpointTable endpoints={READ_ENDPOINTS} />
        <p className="text-sm leading-relaxed text-muted-foreground">
          The record shape is documented as a live{" "}
          <a
            href="/api/schema"
            className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            JSON Schema at /api/schema
          </a>
          , generated directly from the same Zod schema that validates writes
          — it can&rsquo;t drift out of sync with the data.
        </p>
      </section>

      {/* ---- curl examples ---- */}
      <section aria-labelledby="examples-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Examples
        </p>
        <h2 id="examples-heading" className="font-display text-2xl text-foreground">
          curl examples
        </h2>
        <div className="overflow-x-auto rounded-md border border-border bg-muted/50">
          <pre className="p-4 font-mono text-xs leading-relaxed text-foreground">
            <code>{`curl ${siteConfig.url}/api/facilities?state=TX

curl ${siteConfig.url}/api/facilities?type=data_center&status=operational

curl ${siteConfig.url}/api/facilities/${"{id}"}

curl ${siteConfig.url}/api/stats`}</code>
          </pre>
        </div>
      </section>

      {/* ---- Admin writes ---- */}
      <section aria-labelledby="writes-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Writing the data
        </p>
        <h2 id="writes-heading" className="font-display text-2xl text-foreground">
          Admin writes
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Creating, updating, and deleting facility records requires an admin
          bearer token: <code className={CODE}>Authorization: Bearer &lt;token&gt;</code>.
          These are operator endpoints, not public write access.
        </p>
        <EndpointTable endpoints={WRITE_ENDPOINTS} />
      </section>

      {/* ---- Provenance & submissions ---- */}
      <section aria-labelledby="submissions-heading" className="space-y-4 border-t border-border pt-10">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Provenance
        </p>
        <h2 id="submissions-heading" className="font-display text-2xl text-foreground">
          Submissions: discovered, staged, reviewed
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Nothing is auto-published. A candidate record — whether a new
          facility or an update to an existing one — is first{" "}
          <strong className="font-medium text-foreground">staged</strong> as a
          pending submission with its provenance attached, then{" "}
          <strong className="font-medium text-foreground">
            reviewed by a person
          </strong>{" "}
          before it is{" "}
          <strong className="font-medium text-foreground">promoted</strong> to
          a live record. The submissions API is how that staging happens.
          Every submissions endpoint — including the GET list — requires an
          admin bearer token; the queue is not public, since it feeds the
          same human-gated review process used internally. This is
          deliberately slower than auto-ingestion — the atlas optimizes for
          accuracy over count.
        </p>
        <EndpointTable endpoints={SUBMISSION_ENDPOINTS} />
      </section>
    </div>
  );
}
