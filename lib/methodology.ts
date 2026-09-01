import fs from "node:fs";
import path from "node:path";

import { siteConfig } from "@/lib/site";

/**
 * `docs/methodology.md` is the single source of truth for the methodology
 * (see CLAUDE.md "Core invariant" / the maintainer's explicit choice to
 * render the doc rather than hand-port its prose into TSX). This constant is
 * read ONCE, at module-evaluation time, not per-request.
 *
 * `/methodology` (app/methodology/page.tsx) has no `revalidate` export and no
 * dynamic data dependency, so Next prerenders it fully at `next build` — this
 * module therefore only ever executes inside the build process, which always
 * has the full repo checked out. It never runs as a runtime filesystem read
 * inside the deployed serverless function. `next.config.ts`'s
 * `outputFileTracingIncludes` entry for `/methodology` is a second,
 * belt-and-suspenders guard against a future change (e.g. adding
 * `revalidate` or a dynamic API) accidentally turning this into a per-request
 * read that the serverless bundle's file trace hasn't captured.
 */
export const METHODOLOGY_MARKDOWN = fs.readFileSync(
  path.join(process.cwd(), "docs/methodology.md"),
  "utf-8"
);

/**
 * `docs/methodology.md`'s own body, minus its leading `# Methodology` H1
 * line. `app/methodology/page.tsx`'s masthead already renders that exact
 * title as the page's one true `<h1>` — keeping the doc's H1 line in the
 * rendered body would print "Methodology" a second time. This drops only
 * that one line; every other character of the file renders unchanged.
 */
export const METHODOLOGY_BODY_MARKDOWN = METHODOLOGY_MARKDOWN.replace(
  /^# .+\r?\n/,
  ""
);

const EXTERNAL_URL_PATTERN = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * `docs/methodology.md` links to sibling repo docs with paths relative to
 * `docs/` (e.g. `../README.md`, `../CONTRIBUTING.md`, `discovery-pipeline.md`,
 * `../lib/schema.ts`) — correct on GitHub, but there is no `/README.md` or
 * `/lib/schema.ts` route on the public site. Rewrites any relative markdown
 * link to the corresponding file's GitHub blob URL, preserving an in-file
 * `#fragment`. Absolute URLs (`https://…`), same-page fragments (`#…`), and
 * `mailto:` links pass through unchanged.
 *
 * Exported for testing.
 */
export function resolveMethodologyLink(href: string): string {
  if (!href || href.startsWith("#") || EXTERNAL_URL_PATTERN.test(href)) {
    return href;
  }

  const [target, fragment] = href.split("#");
  const repoPath = path.posix.normalize(path.posix.join("docs", target));
  const blobUrl = `${siteConfig.repoUrl}/blob/main/${repoPath}`;
  return fragment ? `${blobUrl}#${fragment}` : blobUrl;
}
