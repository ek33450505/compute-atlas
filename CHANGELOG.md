# Changelog

All notable changes to Compute Atlas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-07-28

### Added

- **Public read API** with caching-first design: `GET /api/facilities`, `/api/stats`, `/api/schema` with edge-cache headers and per-IP rate limiting.
- **Email watch alerts** — double-opt-in subscription for facility changes, state-wide updates, or site-wide digest.
- **RSS feed** for recent activity (`/activity/feed.xml`) with contributor attribution.
- **Opt-in contributor attribution** displayed on activity feed and submission forms.
- **Sponsorship surfaces** — maintainer bio and support-the-atlas blocks on `/about` and `/contribute`.
- **SEO growth pages** — by-status (`/status/*`) and by-metro (`/metros/*`) landing pages with shared CollectionPage template.
- **Per-route canonical URLs** for search engines.
- **Structured data (JSON-LD)** — Organization, WebSite, Dataset, ItemList, Place, and BreadcrumbList for homepage, facility pages, and collection pages.
- **Facility engagement hubs** — rewritten titles and descriptions for search CTR, shareable links, and print-friendly pages.
- **Location fields** — `location.street` and `location.postalCode` for precise geocoding.
- **Error handling** — 404 boundaries, error boundaries, loading skeletons, and empty states throughout.

### Changed

- **Facility titles** rewritten for search engine optimization and discoverability.
- **ISR revalidation** scoped to per-facility (`facility:{id}`) and per-state (`state:{CODE}`) tags for efficient cache refresh.
- **Robots and sitemap** hardened for crawl efficiency (admin UI and API excluded).

### Fixed

- **Email endpoint hardening** — off-path send timing, per-email send rate cap, and safe logging.
- **Status color accessibility** — cancelled status darkened for improved red-green color-deficiency separation.
- **Animation accessibility** — overlay animations and transitions now respect `prefers-reduced-motion`.
- **Energy layer rendering** — energy utility now renders independently of energy.source.
- **Discovery status updates** — append-only updates preserve sourceIndex references (fixes orphaning on approval).
- **State map** — DC (District of Columbia) added to facility state mapping.

### Security

- **API rate limiting** — per-IP request throttling on public endpoints.
- **Email send throttling** — per-email send cap and confirmation token validation.

### Data

- **Enrichment waves:** capacity (MW), energy utility, energy source, community/opposition status, land acreage, investment figures, street address, AI classification tags.
- **Discovery waves:** OSM building scrape (258 colocation net-new), hyperscaler flagship campus enumeration, county GIS hygiene improvements, 71+ coordinate flips to exact precision.
- **Facility count:** 327 → 722 facilities across all states.

## [1.0.0] - 2026-07-15

### Added

- Initial public release.
- Interactive map (MapLibre GL) with globe projection and satellite/street basemaps.
- Facility table with sorting, filtering, and search.
- Data model and Zod schema validation.
- Drizzle ORM and Neon Postgres backend.
- Admin UI for submissions, approvals, and activity audit log.
- Public `/api` endpoints (read-only) and admin-only write endpoints.
- Contribution workflow: staged submissions, human review, and approval gate.
- Discovery pipeline (scheduled, local).
- Accessibility (WCAG 2.2 AA): focus states, keyboard navigation, semantic HTML.
- Dual license: MIT (code) and CC BY 4.0 (data).
