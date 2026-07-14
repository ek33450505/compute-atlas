# Security Policy

Compute Atlas is a public dataset and web app. We take security seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's **[private vulnerability reporting](https://github.com/ek33450505/compute-atlas/security/advisories/new)** (the *"Report a vulnerability"* button under the repository's **Security** tab). This opens a private advisory visible only to you and the maintainer.

We aim to acknowledge reports within a few days and to keep you updated as we investigate and ship a fix.

## Scope

In scope:

- The Compute Atlas web app ([www.compute-atlas.com](https://www.compute-atlas.com)) and this repository's code
- The public API under `/api`
- Data-integrity issues that could let unverified or malicious content enter the dataset

Out of scope:

- Findings that require a compromised maintainer machine or stolen credentials
- Volumetric denial-of-service or stress testing against the live site
- Reports about third-party services we depend on — please report those upstream

## Supported versions

Compute Atlas is a continuously-deployed web app; the live site (`main`) is the only supported version. Fixes ship forward — there are no backported releases.

## Thanks

Responsible disclosures that help keep the atlas trustworthy are genuinely appreciated. With your permission, we're happy to credit you in the published advisory.
