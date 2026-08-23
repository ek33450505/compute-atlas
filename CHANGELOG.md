# Changelog

All notable changes to Compute Atlas are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.29.0](https://github.com/ek33450505/compute-atlas/compare/v1.28.0...v1.29.0) (2026-08-22)


### Features

* **contribute:** lead-first intake — share a link, we take it from there ([#164](https://github.com/ek33450505/compute-atlas/issues/164)) ([e7bf768](https://github.com/ek33450505/compute-atlas/commit/e7bf76877ed10f22b7c8e0592b752c354c831f69))


### Performance Improvements

* **web:** cut hosting cost — fix four cache defects (1,495→468 routes busted per publish) ([#167](https://github.com/ek33450505/compute-atlas/issues/167)) ([a646d59](https://github.com/ek33450505/compute-atlas/commit/a646d59ca06ab22f42d70f43bbdee01bf475b7d0))
* **web:** cut the search index and hero points out of the RSC payload ([#161](https://github.com/ek33450505/compute-atlas/issues/161)) ([1e458fb](https://github.com/ek33450505/compute-atlas/commit/1e458fbe4343db0474fdbdc9e039e169428436fc))
* **web:** stop shipping the full dataset to every client + rebuild the homepage hero ([#160](https://github.com/ek33450505/compute-atlas/issues/160)) ([b0363c7](https://github.com/ek33450505/compute-atlas/commit/b0363c7607f3592c34d3f9eeed57b5090aadad23))

## [1.28.0](https://github.com/ek33450505/compute-atlas/compare/v1.27.0...v1.28.0) (2026-08-17)


### Features

* **discovery:** mechanically verify candidate source URLs before staging ([#150](https://github.com/ek33450505/compute-atlas/issues/150)) ([a5b44e0](https://github.com/ek33450505/compute-atlas/commit/a5b44e0e2669478ee989ffac0eca110fd9faa822))
* **discovery:** pipeline alerting, cap enforcement, rotation rebalance + 93-facility wave (941→1034) ([#156](https://github.com/ek33450505/compute-atlas/issues/156)) ([bc02aff](https://github.com/ek33450505/compute-atlas/commit/bc02aff3d8e8ce0bd8b9bebdebbee79f15803105))
* **discovery:** source-verification census over the live dataset ([#152](https://github.com/ek33450505/compute-atlas/issues/152)) ([c572ca8](https://github.com/ek33450505/compute-atlas/commit/c572ca8acdea954e87d983c85e74a6fac19b4761))
* **discovery:** Track 5 hardening — extraction guards, Unicode dashes, fetch instrumentation + 64-value capacity wave ([#158](https://github.com/ek33450505/compute-atlas/issues/158)) ([76f9ffe](https://github.com/ek33450505/compute-atlas/commit/76f9ffea882ce1bf0adde9d1d69beb352c4daab4))


### Bug Fixes

* **ci:** close the siting-context automation gap + resync 941-facility artifacts ([#155](https://github.com/ek33450505/compute-atlas/issues/155)) ([801ab25](https://github.com/ek33450505/compute-atlas/commit/801ab256017f5f486f68919c3470f57dffa6fdb6))
* **data:** repair 320-char truncated energy and community notes ([c0ef32d](https://github.com/ek33450505/compute-atlas/commit/c0ef32d2d1261681ef68b07267de0df61e6cdec5))
* **discovery:** match entity names by distinctive tokens, not exact canonical string ([#151](https://github.com/ek33450505/compute-atlas/issues/151)) ([acc500a](https://github.com/ek33450505/compute-atlas/commit/acc500a4e7d2375cc9746a6ba08466d34aac7d3a))
* **discovery:** resolve launchd timeout and WebFetch permission blocking ([#154](https://github.com/ek33450505/compute-atlas/issues/154)) ([2d37dba](https://github.com/ek33450505/compute-atlas/commit/2d37dbac0a4838883ebdc1b34ec1af6fa98ac48f))

## [1.27.0](https://github.com/ek33450505/compute-atlas/compare/v1.26.1...v1.27.0) (2026-08-10)


### Features

* **data:** db:sync maintainer write path + heartland wave (890→934) ([#146](https://github.com/ek33450505/compute-atlas/issues/146)) ([aaee0ec](https://github.com/ek33450505/compute-atlas/commit/aaee0ecf3c46bb8ada68d0d61d31726650ba152a))


### Bug Fixes

* **data:** county rendering bug, operator canonicalization, and 10-record enrichment ([#147](https://github.com/ek33450505/compute-atlas/issues/147)) ([d306a55](https://github.com/ek33450505/compute-atlas/commit/d306a557692e1d709ade333d063c86240e9ba95e))

## [1.26.1](https://github.com/ek33450505/compute-atlas/compare/v1.26.0...v1.26.1) (2026-08-08)


### Bug Fixes

* **vercel:** make the ignore gate work in Vercel's shallow clone ([#142](https://github.com/ek33450505/compute-atlas/issues/142)) ([8babbd5](https://github.com/ek33450505/compute-atlas/commit/8babbd5022c83eb201d951d0aa7b708eddd819a0))

## [1.26.0](https://github.com/ek33450505/compute-atlas/compare/v1.25.0...v1.26.0) (2026-08-06)


### Features

* **data:** Ohio deep-coverage pass + LN Compute Georgia crypto (+21 facilities) ([#136](https://github.com/ek33450505/compute-atlas/issues/136)) ([813d198](https://github.com/ek33450505/compute-atlas/commit/813d198554fa1a68a098b37d23a6715741534d54))

## [1.25.0](https://github.com/ek33450505/compute-atlas/compare/v1.24.0...v1.25.0) (2026-08-05)


### Features

* **map:** water & geology overlays, siting-context datums, and map-UX polish ([#133](https://github.com/ek33450505/compute-atlas/issues/133)) ([ca3fecf](https://github.com/ek33450505/compute-atlas/commit/ca3fecff54c3e3c75344043de2f6c323f8d012cd))


### Bug Fixes

* **a11y:** label table scroll region + add motion-reduce guards ([#135](https://github.com/ek33450505/compute-atlas/issues/135)) ([f14c405](https://github.com/ek33450505/compute-atlas/commit/f14c405b8e1adbc65074af71afd20921bfa20bcb))

## [1.24.0](https://github.com/ek33450505/compute-atlas/compare/v1.23.1...v1.24.0) (2026-08-05)


### Features

* **data:** Georgia crypto-mining backfill — 5 CleanSpark + Cango facilities ([#128](https://github.com/ek33450505/compute-atlas/issues/128)) ([1b8125b](https://github.com/ek33450505/compute-atlas/commit/1b8125b38b485ecbf1e7fbbb08f65a9ce1515476))

## [1.23.1](https://github.com/ek33450505/compute-atlas/compare/v1.23.0...v1.23.1) (2026-08-05)


### Bug Fixes

* **data:** add fallback resilience for build-time Neon reads ([#126](https://github.com/ek33450505/compute-atlas/issues/126)) ([33a70ef](https://github.com/ek33450505/compute-atlas/commit/33a70efd02b6521f7b11ff67ce6ce9cc0f22f67f))

## [1.23.0](https://github.com/ek33450505/compute-atlas/compare/v1.22.0...v1.23.0) (2026-08-05)


### Features

* **opposition:** add defeated projects dimension with local-opposition cancellations ([#124](https://github.com/ek33450505/compute-atlas/issues/124)) ([0239a14](https://github.com/ek33450505/compute-atlas/commit/0239a14d80dd4a1a9ef0c2c26536229ba7fcdaa4))

## [1.22.0](https://github.com/ek33450505/compute-atlas/compare/v1.21.0...v1.22.0) (2026-08-05)


### Features

* **data:** crypto-mining geographic expansion — 35 new facilities ([#122](https://github.com/ek33450505/compute-atlas/issues/122)) ([b54a1a0](https://github.com/ek33450505/compute-atlas/commit/b54a1a0e452ca3da2e17743ce3dc1c71b237e75e))

## [1.21.0](https://github.com/ek33450505/compute-atlas/compare/v1.20.0...v1.21.0) (2026-08-05)


### Features

* **data:** crypto-mining wave — 22 second-tier facilities + American Bitcoin attribution ([#120](https://github.com/ek33450505/compute-atlas/issues/120)) ([e86b1b5](https://github.com/ek33450505/compute-atlas/commit/e86b1b506b1ca423dceffbb1020e85e3695af312))

## [1.20.0](https://github.com/ek33450505/compute-atlas/compare/v1.19.0...v1.20.0) (2026-08-05)


### Features

* **schema:** add `fusion` power-generation technology ([#118](https://github.com/ek33450505/compute-atlas/issues/118)) ([1d59ad2](https://github.com/ek33450505/compute-atlas/commit/1d59ad25f4f69b8ff51b54d50425753d3b680c4c))

## [1.19.0](https://github.com/ek33450505/compute-atlas/compare/v1.18.0...v1.19.0) (2026-08-05)


### Features

* **data:** power-generation wave — 11 compute-power facilities + operator cleanup ([#116](https://github.com/ek33450505/compute-atlas/issues/116)) ([8698d66](https://github.com/ek33450505/compute-atlas/commit/8698d66281869e689d62e2cbc3e0b412bc0c7092))

## [1.18.0](https://github.com/ek33450505/compute-atlas/compare/v1.17.0...v1.18.0) (2026-08-04)


### Features

* homepage watch-CTA and Speed Insights monitoring ([#113](https://github.com/ek33450505/compute-atlas/issues/113)) ([df3f183](https://github.com/ek33450505/compute-atlas/commit/df3f1838d5aab998fd8ca1c059c506ab7fc9c09d))

## [1.17.0](https://github.com/ek33450505/compute-atlas/compare/v1.16.0...v1.17.0) (2026-08-03)


### Features

* **data:** SEC-filer mining wave batch 2 — 15 crypto/AI-HPC facilities ([#110](https://github.com/ek33450505/compute-atlas/issues/110)) ([7cf6cf3](https://github.com/ek33450505/compute-atlas/commit/7cf6cf37721a038b3a4359a22def8eb09710e4ae))

## [1.16.0](https://github.com/ek33450505/compute-atlas/compare/v1.15.0...v1.16.0) (2026-08-03)


### Features

* **data:** SEC-filer mining wave batch 1 — 11 crypto/AI-HPC facilities ([#108](https://github.com/ek33450505/compute-atlas/issues/108)) ([24d1226](https://github.com/ek33450505/compute-atlas/commit/24d1226785019bf0eaf83c071413d0608a9be501))

## [1.15.0](https://github.com/ek33450505/compute-atlas/compare/v1.14.0...v1.15.0) (2026-08-03)


### Features

* **data:** Ohio data wave — 4 facilities (Akron, Hamilton, Springfield) ([#106](https://github.com/ek33450505/compute-atlas/issues/106)) ([af3b616](https://github.com/ek33450505/compute-atlas/commit/af3b616cb236dd3542d137f11168ad3de1e1896f))

## [1.14.0](https://github.com/ek33450505/compute-atlas/compare/v1.13.0...v1.14.0) (2026-08-02)


### Features

* **data:** Florida data wave — 8 facilities (Miami, Jacksonville, Orlando, Polk) ([#103](https://github.com/ek33450505/compute-atlas/issues/103)) ([7b50d43](https://github.com/ek33450505/compute-atlas/commit/7b50d433c53539b03588f130a00f5476f32cabc2))


### Bug Fixes

* **activity:** surface bulk-seeded facilities in /activity feed ([#105](https://github.com/ek33450505/compute-atlas/issues/105)) ([41bdf13](https://github.com/ek33450505/compute-atlas/commit/41bdf13b79c57122c94d66a90b410132ba035b3d))

## [1.13.0](https://github.com/ek33450505/compute-atlas/compare/v1.12.0...v1.13.0) (2026-08-02)


### Features

* **data:** deeper California wave — 4 East Bay facilities ([#100](https://github.com/ek33450505/compute-atlas/issues/100)) ([d8893da](https://github.com/ek33450505/compute-atlas/commit/d8893da267e8da5f392b08d00b56b6ccf21f5642))

## [1.12.0](https://github.com/ek33450505/compute-atlas/compare/v1.11.0...v1.12.0) (2026-08-02)


### Features

* **data:** California data wave - 4 facilities + data-wave workflow fixes ([#97](https://github.com/ek33450505/compute-atlas/issues/97)) ([eb77326](https://github.com/ek33450505/compute-atlas/commit/eb773268613a5e3236a11e3ebab263d626791aab))


### Bug Fixes

* **data:** harden bulk go-live — insert-new-safe db:seed + POST /api/revalidate ([#99](https://github.com/ek33450505/compute-atlas/issues/99)) ([bf928c9](https://github.com/ek33450505/compute-atlas/commit/bf928c9940bb326853706dd485b72eab3791978f))

## [1.11.0](https://github.com/ek33450505/compute-atlas/compare/v1.10.2...v1.11.0) (2026-08-01)


### Features

* **map:** siting context, overlays, radius tool, mobile-first + declutter ([#95](https://github.com/ek33450505/compute-atlas/issues/95)) ([a71c9de](https://github.com/ek33450505/compute-atlas/commit/a71c9de1addac38904b11713d226baa0507583fb))

## [1.10.2](https://github.com/ek33450505/compute-atlas/compare/v1.10.1...v1.10.2) (2026-07-31)


### Bug Fixes

* clear all open Dependabot + CodeQL security alerts ([#93](https://github.com/ek33450505/compute-atlas/issues/93)) ([79e6837](https://github.com/ek33450505/compute-atlas/commit/79e6837357d626f9b5a0486dd42290eff3319eed))

## [1.10.1](https://github.com/ek33450505/compute-atlas/compare/v1.10.0...v1.10.1) (2026-07-31)


### Bug Fixes

* **discovery:** fail-open on wrong-shape source-health reports ([#91](https://github.com/ek33450505/compute-atlas/issues/91)) ([67b0f2b](https://github.com/ek33450505/compute-atlas/commit/67b0f2b4380cabf63bc540289c4653196eff9eb5))

## [1.10.0](https://github.com/ek33450505/compute-atlas/compare/v1.9.0...v1.10.0) (2026-07-30)


### Features

* **discovery:** fold light enrichment into each daily run ([#87](https://github.com/ek33450505/compute-atlas/issues/87)) ([3095758](https://github.com/ek33450505/compute-atlas/commit/30957582e2bc815abe77cc9c31558e21d43a3bde))


### Bug Fixes

* **discovery:** accurate source-liveness classification (UA + retry) ([#85](https://github.com/ek33450505/compute-atlas/issues/85)) ([419e1ed](https://github.com/ek33450505/compute-atlas/commit/419e1ed340cddc06bdc6c60dbc4e745d1f3d98b0))

## [1.9.0](https://github.com/ek33450505/compute-atlas/compare/v1.8.0...v1.9.0) (2026-07-30)


### Features

* **discovery:** harden the daily pipeline — session-limit resilience, heartbeat, self-reverting cap ([#83](https://github.com/ek33450505/compute-atlas/issues/83)) ([7985cd4](https://github.com/ek33450505/compute-atlas/commit/7985cd4567e0cdbcdcdbb2f26181351c87031442))

## [1.8.0](https://github.com/ek33450505/compute-atlas/compare/v1.7.0...v1.8.0) (2026-07-30)


### Features

* **brand:** replace the graticule mark with the plate-stack mark ([#81](https://github.com/ek33450505/compute-atlas/issues/81)) ([154036b](https://github.com/ek33450505/compute-atlas/commit/154036b9a23becdc322aa31f862a536462e4dd90))
* **chrome:** redesign header nav and footer as an atlas sitemap ([#79](https://github.com/ek33450505/compute-atlas/issues/79)) ([5509959](https://github.com/ek33450505/compute-atlas/commit/55099597a55d78417e20ec9a58500d17dbf67cbd))

## [1.7.0](https://github.com/ek33450505/compute-atlas/compare/v1.6.0...v1.7.0) (2026-07-30)


### Features

* **home:** modernize the below-hero into a data-showcase gateway ([#77](https://github.com/ek33450505/compute-atlas/issues/77)) ([b542cfd](https://github.com/ek33450505/compute-atlas/commit/b542cfdcad81e0f002d705f9662c2a1adefc9c30))

## [1.6.0](https://github.com/ek33450505/compute-atlas/compare/v1.5.3...v1.6.0) (2026-07-30)


### Features

* **home:** lead with a living parchment-globe hero ([#75](https://github.com/ek33450505/compute-atlas/issues/75)) ([a961da9](https://github.com/ek33450505/compute-atlas/commit/a961da94ff0d36338e42191685ced858cbca83fe))

## [1.5.3](https://github.com/ek33450505/compute-atlas/compare/v1.5.2...v1.5.3) (2026-07-30)


### Bug Fixes

* **ui:** relabel back-link to "Back to Compute Atlas" on subscribe/404/error pages ([#72](https://github.com/ek33450505/compute-atlas/issues/72)) ([8866377](https://github.com/ek33450505/compute-atlas/commit/886637790894b7e9f29bdfc3bc1ca9e657e1f944))

## [1.5.2](https://github.com/ek33450505/compute-atlas/compare/v1.5.1...v1.5.2) (2026-07-30)


### Performance Improvements

* **data:** index operator lookups; memoize JSON fallback validation ([#67](https://github.com/ek33450505/compute-atlas/issues/67)) ([52d6d5c](https://github.com/ek33450505/compute-atlas/commit/52d6d5c4ea18a3f8ed32abcb7beb66a4354689fa))

## [1.5.1](https://github.com/ek33450505/compute-atlas/compare/v1.5.0...v1.5.1) (2026-07-29)


### Bug Fixes

* **power:** cooling-method caption + footer cleanup; refresh dataset snapshot (310 -&gt; 727) ([#64](https://github.com/ek33450505/compute-atlas/issues/64)) ([66bce18](https://github.com/ek33450505/compute-atlas/commit/66bce184d03cdf2df15dae43cd6e87d26a147b23))

## [1.5.0](https://github.com/ek33450505/compute-atlas/compare/v1.4.0...v1.5.0) (2026-07-29)


### Features

* **seo:** AI-classification-by-state hub — /ai page + query helpers (Tier 2 Session 6) ([#58](https://github.com/ek33450505/compute-atlas/issues/58)) ([75def5d](https://github.com/ek33450505/compute-atlas/commit/75def5de982fa6c84a6ee2297d6f310594f48fd4))
* **seo:** crypto mining hub — /crypto page + query helpers (Tier 2 Session 5) ([#56](https://github.com/ek33450505/compute-atlas/issues/56)) ([7857e0e](https://github.com/ek33450505/compute-atlas/commit/7857e0e2d2c9572d5808d7ae53cbaf0c35e0ef1d))
* **seo:** facility-level water usage on /power — helper + section (Tier 2 Session 7) ([#59](https://github.com/ek33450505/compute-atlas/issues/59)) ([40165af](https://github.com/ek33450505/compute-atlas/commit/40165af8b8ad63c5a9b114a543a3e6b4f9ddfe2a))
* **seo:** learn/glossary hub — /learn index + [topic] pages + glossary registry (Tier 2 Session 11) ([#61](https://github.com/ek33450505/compute-atlas/issues/61)) ([99d2513](https://github.com/ek33450505/compute-atlas/commit/99d2513dc7817b01c33872757752c0ea19d4c76f))
* **seo:** rankings hub — /rankings page + capacity-ranking helpers (Tier 2 Session 10) ([#60](https://github.com/ek33450505/compute-atlas/issues/60)) ([8426cad](https://github.com/ek33450505/compute-atlas/commit/8426cade002aeec115f28adedf42ee5e51112b64))

## [1.4.0](https://github.com/ek33450505/compute-atlas/compare/v1.3.0...v1.4.0) (2026-07-29)


### Features

* **seo:** power depth + quarterly pipeline freshness (Tier 2 Session 4) ([#54](https://github.com/ek33450505/compute-atlas/issues/54)) ([6c94515](https://github.com/ek33450505/compute-atlas/commit/6c945153e386378d4ea6486001d97da0f6597e8f))

## [1.3.0](https://github.com/ek33450505/compute-atlas/compare/v1.2.0...v1.3.0) (2026-07-29)


### Features

* **seo:** add opposition depth — notable cases section + states cross-link ([#51](https://github.com/ek33450505/compute-atlas/issues/51)) ([e51e5bf](https://github.com/ek33450505/compute-atlas/commit/e51e5bff049d17f17d460a9eaf85e555902fee40))

## [1.2.0](https://github.com/ek33450505/compute-atlas/compare/v1.1.0...v1.2.0) (2026-07-28)


### Features

* **seo:** keyword H1 + templated prose on operators & metros hubs ([#50](https://github.com/ek33450505/compute-atlas/issues/50)) ([ee6c68a](https://github.com/ek33450505/compute-atlas/commit/ee6c68adc68dc2f8665fc1515fe38640a6ca2147))
* **seo:** keyword H1s + templated prose on states/opposition/power/status hubs ([#48](https://github.com/ek33450505/compute-atlas/issues/48)) ([db623bb](https://github.com/ek33450505/compute-atlas/commit/db623bbf6952a79c5df29a1ac1d159b77472dbfe))

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
