# Documentation

This directory contains guides for understanding and contributing to Compute Atlas.

- **[methodology.md](methodology.md)** — The discovery channels (county portals, SEC filings, utility queues), sourcing and verification standard, and how to read a facility's sources.

- **[discovery-pipeline.md](discovery-pipeline.md)** — How the automated discovery pipeline works: scheduling, data validation, staging, and the submission workflow.

- **[discovery-runbook.md](discovery-runbook.md)** — Day-to-day operations: running the pipeline manually, installing/managing the launchd job, reviewing submissions, and using the field extraction and leads lane tools.

- **[maintainers.md](maintainers.md)** — Maintainer-only operations: the data-wave workflow (`db:sync` → `db:export` → `build:mapdata`), database scripts, environment variables, releases, the build gate, and the caching model. Requires `DATABASE_URL`.

For the project architecture, tech stack, and data model, see the main [README.md](../README.md).
