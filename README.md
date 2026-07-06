# Compute Atlas

A free, neutral, open tracker of AI datacenters across the United States — from proposed and permitted to under construction and operational — with a source for every record.

## What it is

There is no national registry of AI datacenters. "AI datacenter" is not a legal category. Compute Atlas fills that gap by curating a provenance-first dataset of large-scale GPU/accelerator facilities, drawn from public permit filings, utility interconnection queues, company announcements, and subsidy disclosures. Every record carries confidence levels and links its sources.

Intended audience: journalists, researchers, local officials, and residents.

## Tech stack

- **Next.js 16** (App Router, static export) with **React 19**
- **TypeScript** + **Zod** for runtime-validated data
- **MapLibre GL** + **react-map-gl** for the interactive map
- **Tailwind CSS v4** + **shadcn/ui** components
- **Vitest** + **React Testing Library** for unit tests
- **Playwright** for end-to-end tests

## Local development

```bash
npm install
npm run dev        # start dev server at http://localhost:3000
npm run test       # run unit tests (Vitest)
npm run test:e2e   # run E2E tests (Playwright — requires npm run build first)
npm run build      # production build
npm run lint       # ESLint
npm run typecheck  # TypeScript type check
```

## Data model

Facility records live in `data/facilities.json` — a JSON array validated at build time against the Zod schema in `lib/schema.ts`.

Key fields per facility:

| Field | Description |
|---|---|
| `id` | Lowercase kebab slug (e.g. `xai-colossus-memphis-tn`) |
| `name` | Facility name |
| `operator` | Operating company |
| `status` | `proposed` / `permitted` / `under_construction` / `operational` / `cancelled` |
| `aiClassification` | `confirmed` / `likely` / `mixed_use` |
| `confidence` | `confirmed` / `reported` / `rumored` |
| `location` | `lat`, `lon`, `city?`, `county?`, `state` (2-letter) |
| `capacityMw` | `planned?` and/or `operational?` in megawatts |
| `statusHistory` | Ordered list of status transitions with dates and source references |
| `sources` | At least one source with `url`, `label`, `kind`, and `retrievedAt` |
| `lastUpdated` | ISO date string (YYYY or YYYY-MM or YYYY-MM-DD) |

### How to add a facility

1. Add an entry to `data/facilities.json` following the schema above.
2. Include at least one `sources` entry — every record must cite a public source.
3. Run `npm run build` — the build validates all records against the schema and will fail loudly if any field is missing or malformed.

## Accessibility

Compute Atlas targets **WCAG 2.2 AA**. The data table is a first-class alternative to the map — all facilities are reachable and filterable without pointer interaction. Focus indicators, skip-to-content link, and semantic HTML throughout.

## Contributing and corrections

Open an issue at `https://github.com/ek33450505/compute-atlas/issues`. Corrections should include a public source URL. Pull requests welcome for new facilities and data updates.

## Attribution and licenses

- Map basemap: OpenStreetMap contributors (ODbL) via OpenFreeMap
- Epoch AI data (where used): CC-BY 4.0
- Codebase and original data: see repository license
