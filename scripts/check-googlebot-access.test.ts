// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isBlocked, loadCredentials, type IndexStatusResult } from "./check-googlebot-access";

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
