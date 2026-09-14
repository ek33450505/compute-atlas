/**
 * Domains whose terms of use forbid redistributing what we'd learn from them,
 * even though their robots.txt permits a crawler to fetch the page.
 *
 * robots.txt answers "may your crawler fetch this page?" Terms of Use answer
 * "may you republish what you found?" Those are different questions. Compute
 * Atlas publishes its dataset under CC-BY-4.0 (see LICENSE-DATA) — anything we
 * ingest as a fact has to be freely re-licensable downstream. A domain whose
 * terms prohibit "bulk downloading, scraping, or redistribution of the data
 * without prior written consent" and asserts "All rights reserved" binds
 * harder than its own robots.txt allows, because OUR output licence is
 * permissive. Ingesting facts sourced from such a domain would both breach
 * its terms and inject un-relicensable data into a corpus whose whole claim
 * is that every fact is traceable and freely reusable.
 *
 * ⚠️ A LINK IS NOT REDISTRIBUTION. This guard exists to stop the discovery
 * pipeline from treating a restricted domain as a candidate SOURCE to ingest
 * facts from — it is not a ban on the domain string appearing anywhere, and
 * it is deliberately NOT part of `facilitySchema` (lib/schema.ts) — that was
 * considered and rejected as too blunt; the schema describes facility shape,
 * not source provenance policy.
 *
 * Scope, Ed's decision 2026-09-14: interconnection.fyi ONLY, for now.
 * Read 2026-09-14: robots.txt allows `/`, but the Terms of Use page states
 * "Bulk downloading, scraping, or redistribution of the data without prior
 * written consent is prohibited" and "© 2026 Interconnection.fyi. All rights
 * reserved." PR #312 swept these citations out of the dataset by hand, with
 * no guard; the pipeline re-introduced them within days. This module — plus
 * the pipeline check in scripts/discovery/verify-source.ts and the dataset
 * regression test in lib/restricted-sources.dataset.test.ts — is the guard.
 *
 * Other frequently-cited aggregators (baxtel.com, datacenter.fyi,
 * cleanview.co, ailawtracker.org) are NOT on this list. Their terms have not
 * been read. Do not add them without reading and dating the evidence first —
 * this file is a source of truth precisely because every entry is backed by
 * a read, not a guess.
 *
 * Centralization pattern mirrors lib/cache-tags.ts: one shared list so the
 * discovery-pipeline guard (scripts/discovery/verify-source.ts) and the
 * dataset-level regression test (lib/restricted-sources.dataset.test.ts)
 * read from the same source and cannot drift apart.
 */

export interface RestrictedSourceDomain {
  /** Lowercase registrable domain, no scheme, no leading dot. */
  domain: string;
  /** Why this domain is restricted — surfaced in rejection messages. */
  reason: string;
  /** ISO date (YYYY-MM-DD) the domain's Terms of Use were actually read. */
  termsReadDate: string;
}

export const RESTRICTED_SOURCE_DOMAINS: readonly RestrictedSourceDomain[] = [
  {
    domain: "interconnection.fyi",
    reason:
      "interconnection.fyi's Terms of Use prohibit bulk downloading, scraping, " +
      "or redistribution of its data without prior written consent, and assert " +
      "\"All rights reserved.\" Compute Atlas publishes its dataset under " +
      "CC-BY-4.0, so citing facts sourced from this site would both breach its " +
      "terms and inject un-relicensable data into the dataset. Use the site by " +
      "hand to locate a project, then cite the ISO/RTO's own published " +
      "interconnection queue — that is directly citable.",
    termsReadDate: "2026-09-14",
  },
] as const;

/**
 * True if `url`'s hostname is a restricted domain, or a subdomain of one
 * (e.g. `www.interconnection.fyi`). Matching is exact-or-dot-suffix on the
 * parsed, lowercased hostname — never a bare `String.includes`, so a
 * lookalike host like `notinterconnection.fyi` or
 * `interconnection.fyi.evil.com` never matches.
 *
 * An unparseable URL returns `false`. It is not this function's job to
 * validate URLs — a malformed URL isn't a restricted source, it's a
 * different problem for a different check to catch.
 */
export function isRestrictedSourceUrl(url: string): boolean {
  return findRestrictedDomain(url) !== null;
}

/**
 * The reason a restricted URL is restricted, for use in an error/verdict
 * message. `null` if `url` does not match a restricted domain (including
 * unparseable URLs).
 */
export function restrictedSourceReason(url: string): string | null {
  return findRestrictedDomain(url)?.reason ?? null;
}

function findRestrictedDomain(url: string): RestrictedSourceDomain | null {
  let hostname: string;
  try {
    // A trailing dot is a valid FQDN form — `interconnection.fyi.` resolves to
    // the SAME host as `interconnection.fyi`, but `new URL()` preserves the dot
    // in `.hostname`, so neither the equality nor the dot-suffix check below
    // would match it. Stripping it is what makes the two spellings one host.
    // Found by probe and independently by code review, 2026-09-14, while the
    // guard was still unmerged.
    hostname = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (!hostname) return null;

  for (const entry of RESTRICTED_SOURCE_DOMAINS) {
    const domain = entry.domain.toLowerCase();
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return entry;
    }
  }
  return null;
}
