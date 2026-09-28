// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  classifyMissingCredential,
  isBlocked,
  isCi,
  loadCredentials,
  type IndexStatusResult,
} from "./check-googlebot-access";

// ---------------------------------------------------------------------------
// isBlocked — pure classification, no network
// ---------------------------------------------------------------------------
// A `fetch` stub that throws proves these tests never touch the network:
// if isBlocked() (or anything it transitively called) tried to fetch, the
// test would fail loudly instead of silently passing off a real response.
describe("isBlocked", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("no network calls allowed in this test file");
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flags a 403 coverageState as blocked", () => {
    const result: IndexStatusResult = {
      coverageState: "Blocked due to access forbidden (403)",
    };
    expect(isBlocked(result)).toBe(true);
  });

  // Isolates the "403" substring branch of the coverageState check from the
  // "blocked" substring branch — real Google wording always pairs the two
  // ("Blocked due to access forbidden (403)"), so a fixture containing only
  // "blocked" would still pass this suite even if the 403-matching arm of
  // the `||` were broken. This case has no "blocked" text at all, so it can
  // only pass via the 403 arm.
  it("flags a coverageState containing only '403' (no 'blocked' text) as blocked", () => {
    const result: IndexStatusResult = {
      coverageState: "Error 403 fetching page",
    };
    expect(isBlocked(result)).toBe(true);
  });

  it("matches coverageState case-insensitively", () => {
    const result: IndexStatusResult = {
      coverageState: "BLOCKED DUE TO ACCESS FORBIDDEN (403)",
    };
    expect(isBlocked(result)).toBe(true);
  });

  it("flags robotsTxtState DISALLOWED as blocked", () => {
    const result: IndexStatusResult = {
      coverageState: "Submitted and indexed",
      robotsTxtState: "DISALLOWED",
    };
    expect(isBlocked(result)).toBe(true);
  });

  it("flags pageFetchState ACCESS_FORBIDDEN as blocked", () => {
    const result: IndexStatusResult = {
      coverageState: "Submitted and indexed",
      pageFetchState: "ACCESS_FORBIDDEN",
    };
    expect(isBlocked(result)).toBe(true);
  });

  it("does NOT flag 'Discovered - currently not indexed' — normal crawl-budget state", () => {
    const result: IndexStatusResult = {
      coverageState: "Discovered - currently not indexed",
    };
    expect(isBlocked(result)).toBe(false);
  });

  it("does NOT flag 'URL is unknown to Google' — normal crawl-budget state", () => {
    const result: IndexStatusResult = {
      coverageState: "URL is unknown to Google",
    };
    expect(isBlocked(result)).toBe(false);
  });

  it("does NOT flag 'Submitted and indexed' — healthy state", () => {
    const result: IndexStatusResult = {
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
    };
    expect(isBlocked(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadCredentials — pure env/file resolution, no network
// ---------------------------------------------------------------------------
describe("loadCredentials", () => {
  it("prefers GSC_SERVICE_ACCOUNT_JSON content over the file path", () => {
    const env: Partial<NodeJS.ProcessEnv> = {
      GSC_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: "svc@example.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    };

    const creds = loadCredentials(env);
    expect(creds?.client_email).toBe("svc@example.iam.gserviceaccount.com");
  });

  it("returns null when neither env var nor default file path resolves", () => {
    const env: Partial<NodeJS.ProcessEnv> = {
      GSC_CREDENTIALS_PATH: "/definitely/not/a/real/path/service-account.json",
    };

    expect(loadCredentials(env)).toBeNull();
  });

  // Distinguishes "malformed credential" (real misconfiguration, must
  // fail-closed and throw) from "no credential" (expected, returns null and
  // exits 0). A malformed GSC_SERVICE_ACCOUNT_JSON must never be silently
  // swallowed into the null/no-credential path.
  it("throws (does not return null) when GSC_SERVICE_ACCOUNT_JSON is malformed JSON", () => {
    const env: Partial<NodeJS.ProcessEnv> = {
      GSC_SERVICE_ACCOUNT_JSON: '{"private_key":"SENTINEL_SHOULD_NOT_LEAK',
    };

    expect(() => loadCredentials(env)).toThrow();
  });

  // The finding under test: the thrown error must be generic and must not
  // carry any input-derived text. Node's raw JSON.parse SyntaxError doesn't
  // literally echo the source string, but it DOES embed parser context
  // ("position"/"line"/"column") derived from walking the input — that's
  // exactly the kind of input-derived text this finding is about, so this
  // asserts on it directly, not just the sentinel substring (a bare
  // SyntaxError happens not to contain that literal substring either way —
  // see mutation-test note in the Work Log). GitHub Actions only masks
  // exact-match registered secrets, so any of this leaking would be unmasked.
  it("does not leak any input-derived text in the thrown error message", () => {
    const env: Partial<NodeJS.ProcessEnv> = {
      GSC_SERVICE_ACCOUNT_JSON: '{"private_key":"SENTINEL_SHOULD_NOT_LEAK',
    };

    let thrown: unknown;
    try {
      loadCredentials(env);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain("SENTINEL_SHOULD_NOT_LEAK");
    expect(message).not.toContain("private_key");
    expect(message).not.toMatch(/position|line \d|column/i);
    expect(message).toBe(
      "Failed to parse GSC service-account credentials (malformed JSON) from GSC_SERVICE_ACCOUNT_JSON"
    );
  });
});

// ---------------------------------------------------------------------------
// The unarmed gate: a canary that cannot run must not report green in CI
// ---------------------------------------------------------------------------
// WHAT A PASSING CHECK LOOKS LIKE WHILE THE BUG IS PRESENT: nothing does, in
// the subprocess cases below — they assert the real process exit code, which is
// the whole deliverable. The bug being fixed was measured on 2026-09-27: with
// no GSC_SERVICE_ACCOUNT_JSON secret, all 10 most recent scheduled runs of
// googlebot-canary.yml reported success, every one a skip. Reverting the gate
// (making main() exit 0 unconditionally on a missing credential) makes the
// CI-set case below fail — mutation-tested both directions.
//
// Every `env` here is INJECTED, never read from the ambient process. CI is set
// on the GitHub runner, so a test that relied on the real `process.env.CI`
// could not exercise the not-in-CI branch there at all — the same shape as a
// TZ-determinism test that cannot fail on a UTC runner.
describe("isCi", () => {
  it("is true for the value GitHub Actions actually sets", () => {
    expect(isCi({ CI: "true" })).toBe(true);
  });

  it("is true for any other non-empty value (Vercel sets CI=1)", () => {
    expect(isCi({ CI: "1" })).toBe(true);
  });

  it("is false when CI is absent", () => {
    expect(isCi({})).toBe(false);
  });

  it("is false when CI is empty or whitespace", () => {
    expect(isCi({ CI: "" })).toBe(false);
    expect(isCi({ CI: "   " })).toBe(false);
  });

  // Some toolchains set CI=false deliberately; an env var that cannot be
  // turned off is not a flag.
  it("honours an explicit opt-out", () => {
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "FALSE" })).toBe(false);
    expect(isCi({ CI: "0" })).toBe(false);
  });
});

describe("classifyMissingCredential", () => {
  it("fails closed in CI, naming the missing secret", () => {
    const outcome = classifyMissingCredential({ CI: "true" });

    expect(outcome.fail).toBe(true);
    expect(outcome.message).toContain("::error::");
    expect(outcome.message).toContain("UNARMED");
    expect(outcome.message).toContain("GSC_SERVICE_ACCOUNT_JSON");
  });

  it("skips (exit 0) outside CI, so a local hand-run is not blocked", () => {
    const outcome = classifyMissingCredential({});

    expect(outcome.fail).toBe(false);
    expect(outcome.message).toContain("::notice::");
    expect(outcome.message).toContain("skipping Googlebot-access canary");
  });

  it("names both credential sources it checked, in either branch", () => {
    for (const env of [{ CI: "true" }, {}]) {
      const { message } = classifyMissingCredential(env);
      expect(message).toContain("GSC_SERVICE_ACCOUNT_JSON");
      expect(message).toContain("GSC_CREDENTIALS_PATH");
    }
  });
});

// End-to-end on the real exit status, because "exits non-zero" is the
// requirement and a pure-function assertion about `fail: true` is a proxy for
// it. Runs the CLI exactly as the workflow does (`tsx <script>` from the repo
// root).
//
// NO NETWORK: GSC_CREDENTIALS_PATH points at a path that cannot exist, and
// loadCredentials() consults `env.GSC_CREDENTIALS_PATH || <default>` — so the
// maintainer's real ~/.config/gsc-mcp/service-account.json is never read, the
// credential resolves to null, and main() returns before fetchAccessToken().
// GSC_SERVICE_ACCOUNT_JSON is explicitly stripped from the child env for the
// same reason.
describe("the CLI's exit status when no credential resolves", () => {
  const SCRIPT = resolve(__dirname, "check-googlebot-access.ts");
  const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
  const REPO_ROOT = resolve(__dirname, "..");

  function runCli(extraEnv: Record<string, string>) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GSC_CREDENTIALS_PATH: "/definitely/not/a/real/path/service-account.json",
      ...extraEnv,
    };
    delete env.GSC_SERVICE_ACCOUNT_JSON;
    if (extraEnv.CI === undefined) delete env.CI;

    const result = spawnSync(TSX, [SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    // A spawn that never started reports status === null, which would pass
    // `not.toBe(0)` vacuously. Surface the real cause instead.
    expect(result.error).toBeUndefined();
    return result;
  }

  it("exits non-zero in CI — an unarmed canary is a failure, not a pass", () => {
    const result = runCli({ CI: "true" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("UNARMED");
  }, 60_000);

  it("exits 0 with the skip notice outside CI", () => {
    const result = runCli({});

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "skipping Googlebot-access canary"
    );
  }, 60_000);
});
