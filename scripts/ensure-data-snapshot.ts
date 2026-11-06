/**
 * Makes sure the data/ snapshot files the app imports statically exist.
 *
 *   - Vercel (VERCEL=1): export from Neon. If the export fails, a build
 *     exits non-zero unless VERCEL_ENV is exactly "preview" (fail closed: never
 *     ship fixture data to prod); a preview build falls back to fixtures for
 *     absent files only, with a loud warning. Every Vercel build, production
 *     and preview, runs a Neon export in prebuild, so a Neon outage fails a
 *     production deploy by design (never ship fixture or stale data to prod);
 *     retry the deploy. ALLOW_FIXTURE_SNAPSHOT is deliberately ignored when
 *     VERCEL=1.
 *   - Elsewhere: copy a fixture into data/ only for files that are absent. Never
 *     overwrites an existing file, except facilities.meta.json when
 *     facilities.json is absent: the pair is copied together so recordCount
 *     matches.
 *   - `--export` forces a Neon export on any machine; failure exits non-zero.
 *
 *   - CI or NODE_ENV=production off Vercel: a missing snapshot file exits
 *     non-zero rather than copying fixtures, unless ALLOW_FIXTURE_SNAPSHOT=1.
 *     npm does not set NODE_ENV for lifecycle scripts, so a self-hosted or
 *     non-Vercel production build must set CI or NODE_ENV=production for this
 *     guard to apply. A plain local `npm run build` with no DB copies the
 *     fixture by design, so contributors can build.
 *
 * Wired as `predev` and `prebuild` (never with `--export`).
 *
 * Logs never include URLs or bound params: a DB error is reduced to
 * `redactedErrorCode(err)`.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { redactedErrorCode } from "../lib/db-error";
import { isEntrypoint } from "./is-entrypoint";

/** fixture file -> snapshot file, both relative to the repo root. */
export const SNAPSHOT_FILES: ReadonlyArray<{ fixture: string; snapshot: string }> = [
  { fixture: "tests/fixtures/facilities.fixture.json", snapshot: "data/facilities.json" },
  { fixture: "tests/fixtures/facilities.meta.fixture.json", snapshot: "data/facilities.meta.json" },
  { fixture: "tests/fixtures/siting-context.fixture.json", snapshot: "data/siting-context.json" },
  { fixture: "tests/fixtures/operator-ownership.fixture.json", snapshot: "data/operator-ownership.json" },
];

export interface SnapshotFs {
  existsSync(p: string): boolean;
  copyFileSync(src: string, dest: string): void;
  mkdirSync(p: string, opts: { recursive: true }): unknown;
}

export interface SnapshotDeps {
  root: string;
  env: Record<string, string | undefined>;
  fs: SnapshotFs;
  /** Runs the Neon export (scripts/export.ts). Rejects on failure. */
  exportFacilities: () => Promise<unknown>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

const FACILITIES = "data/facilities.json";
const META = "data/facilities.meta.json";

/**
 * Copies fixtures into data/ without ever overwriting an existing file.
 * facilities.json and its meta are a pair: both are copied only when
 * facilities.json is absent; a meta missing next to a real facilities.json is
 * left missing (a fixture meta would claim the wrong recordCount). The other
 * two files are copied individually when absent. Returns whether anything was
 * copied; warns about whatever was copied or skipped.
 */
function fillMissing(deps: SnapshotDeps, why: string): boolean {
  const has = (snapshot: string) => deps.fs.existsSync(path.join(deps.root, snapshot));
  const copied: string[] = [];
  const copy = (snapshot: string) => {
    const entry = SNAPSHOT_FILES.find((f) => f.snapshot === snapshot);
    if (!entry) throw new Error(`no fixture registered for ${snapshot}`);
    const dest = path.join(deps.root, snapshot);
    deps.fs.mkdirSync(path.dirname(dest), { recursive: true });
    deps.fs.copyFileSync(path.join(deps.root, entry.fixture), dest);
    copied.push(snapshot);
  };

  if (!has(FACILITIES)) {
    copy(FACILITIES);
    copy(META);
  } else if (!has(META)) {
    deps.warn(`ensure-data-snapshot: WARNING ${META} is missing next to a real ${FACILITIES}; not copying a fixture meta (wrong recordCount). Run \`npm run db:export\`.`);
  }
  for (const { snapshot } of SNAPSHOT_FILES) {
    if (snapshot === FACILITIES || snapshot === META) continue;
    if (!has(snapshot)) copy(snapshot);
  }

  if (copied.length > 0) {
    deps.warn(
      `ensure-data-snapshot: WARNING ${why}. Copied fixtures into ${copied.join(", ")}; ` +
        `this is a ~68-record sample, NOT the real dataset.`
    );
  }
  return copied.length > 0;
}

/** Returns the process exit code. */
export async function ensureDataSnapshot(
  opts: { forceExport: boolean },
  deps: SnapshotDeps
): Promise<number> {
  const tryExport = async (): Promise<boolean> => {
    try {
      await deps.exportFacilities();
      deps.log("ensure-data-snapshot: exported snapshot from Neon");
      return true;
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "MissingDatabaseUrlError") {
        deps.warn("ensure-data-snapshot: DATABASE_URL not set, skipping Neon export");
      } else {
        deps.warn(`ensure-data-snapshot: Neon export failed (${redactedErrorCode(err)})`);
      }
      return false;
    }
  };

  if (opts.forceExport) {
    return (await tryExport()) ? 0 : 1;
  }

  if (deps.env.VERCEL === "1") {
    if (await tryExport()) return 0;
    // Allowlist: only an explicit preview build may fall back. Production,
    // development, or an unset/unknown VERCEL_ENV all fail closed.
    if (deps.env.VERCEL_ENV !== "preview") {
      deps.warn("ensure-data-snapshot: refusing to build without a Neon export (VERCEL_ENV is not preview)");
      return 1;
    }
    if (!fillMissing(deps, "Neon export failed on a preview Vercel build")) {
      deps.warn("ensure-data-snapshot: WARNING Neon export failed on a preview build; existing data/ files left as they are");
    }
    return 0;
  }

  // A CI or production build must never silently ship fixture data.
  if (deps.env.CI || deps.env.NODE_ENV === "production") {
    const missing = SNAPSHOT_FILES.filter((f) => !deps.fs.existsSync(path.join(deps.root, f.snapshot)));
    if (missing.length > 0 && deps.env.ALLOW_FIXTURE_SNAPSHOT !== "1") {
      deps.warn(
        `ensure-data-snapshot: refusing to copy fixtures in CI/production; missing ${missing.map((f) => f.snapshot).join(", ")}. ` +
          `Set ALLOW_FIXTURE_SNAPSHOT=1 to allow a fixture build.`
      );
      return 1;
    }
  }

  if (!fillMissing(deps, "data/ snapshot files were missing")) {
    deps.log("ensure-data-snapshot: nothing to copy");
  }
  return 0;
}

async function main(): Promise<void> {
  const code = await ensureDataSnapshot(
    { forceExport: process.argv.includes("--export") },
    {
      root: process.cwd(),
      env: process.env,
      fs: { existsSync, copyFileSync, mkdirSync },
      exportFacilities: async () => {
        const { exportFacilities } = await import("./export");
        return exportFacilities();
      },
      log: (m) => console.log(m),
      warn: (m) => console.warn(m),
    }
  );
  process.exit(code);
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    console.error(`ensure-data-snapshot: fatal (${redactedErrorCode(err)})`);
    process.exit(1);
  });
}
