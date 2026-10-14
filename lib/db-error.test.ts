import { describe, it, expect } from "vitest";

import { neon } from "@neondatabase/serverless";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { formatFatalError, redactedErrorCode } from "@/lib/db-error";

/**
 * The secret this whole helper exists to keep out of the logs. It stands in
 * for whatever a real DrizzleQueryError would carry in that position — a
 * subscriber's plaintext email, a visitor's search text, an IP hash, or a live
 * raw bearer token.
 */
const SECRET = "secret-value-123";

/**
 * A DrizzleQueryError-shaped error: drizzle-orm's wrapper puts
 * `Failed query: <sql> params: <bound values>` in its OWN `.message` and keeps
 * the driver error (which is where the SQLSTATE `code` actually lives) on
 * `.cause`. Both layers matter — the wrapper carries the leak and no code, the
 * cause carries the code and no leak — which is why the helper walks both.
 */
function drizzleShapedError(params: string, code = "42P01"): Error {
  const driverError = Object.assign(
    new Error(`relation "subscriptions" does not exist`),
    { code },
  );
  return new Error(
    `Failed query: select "id" from "subscriptions" where "email" = $1 params: ${params}`,
    { cause: driverError },
  );
}

describe("redactedErrorCode", () => {
  it("returns the SQLSTATE and never the bound params embedded in a DrizzleQueryError message", () => {
    const err = drizzleShapedError(SECRET);

    // Sanity-check the fixture itself: if the secret were not really in the
    // error, this test could pass without the helper redacting anything (the
    // "fixture that coincides" failure mode).
    expect(err.message).toContain(`params: ${SECRET}`);

    const redacted = redactedErrorCode(err);

    expect(redacted).not.toContain(SECRET);
    expect(redacted).toBe("42P01");
  });

  it("reads a code carried on the error itself, not only on .cause", () => {
    const err = Object.assign(
      new Error(`connection terminated — params: ${SECRET}`),
      {
        code: "08006",
      },
    );

    const redacted = redactedErrorCode(err);

    expect(redacted).toBe("08006");
    expect(redacted).not.toContain(SECRET);
  });

  it("prefers the outer layer's code when both layers carry one", () => {
    const err = Object.assign(drizzleShapedError(SECRET, "42P01"), {
      code: "23505",
    });

    expect(redactedErrorCode(err)).toBe("23505");
  });

  it('returns "unknown" — never the message — for an error carrying no code at all', () => {
    const err = new Error(`Failed query: select 1 params: ${SECRET}`);

    const redacted = redactedErrorCode(err);

    expect(redacted).toBe("unknown");
    expect(redacted).not.toContain(SECRET);
  });

  it("ignores a present-but-empty code rather than returning an empty string", () => {
    const err = Object.assign(new Error("no useful code"), { code: "" });

    expect(redactedErrorCode(err)).toBe("unknown");
  });

  it("ignores a non-string code (a driver that surfaces a numeric errno)", () => {
    const err = Object.assign(new Error("numeric errno"), { code: 1234 });

    expect(redactedErrorCode(err)).toBe("unknown");
  });

  /**
   * DELIBERATE, not an oversight — and this test exists to fail on the change
   * that "fixes" it. The guard is `typeof code === "string" && code.length > 0`;
   * a review of this helper proposed tightening it to `/^[0-9A-Z]{5}$/` (a
   * strict Postgres SQLSTATE), since the value is interpolated into a log line
   * unvalidated. That regex is a regression twice over:
   *
   *  - **neon-http** does not always surface a 5-char SQLSTATE, so the regex
   *    would blank out the only discriminator those errors carry — every DB
   *    failure on the production driver would log "unknown".
   *  - it coerces Node's own network codes to "unknown", `ENOTFOUND` included.
   *    On this project `ENOTFOUND` is specifically the recorded discriminator
   *    between a network/DNS outage and genuine link rot in a cited source URL;
   *    losing it makes "the internet was down" and "this citation is dead" the
   *    same log line.
   *
   * Redaction does not depend on the code's shape: a driver `code` comes from a
   * fixed vocabulary of identifiers, never from caller data, so returning an
   * unfamiliar one verbatim leaks nothing. The leak this helper exists to stop
   * lives in `.message`, which is never read at all.
   *
   * The cases below are chosen so each half of that regex fails on its own:
   * `ENOTFOUND` passes the charset but not the `{5}` length, and `57p01` passes
   * the length but not the `[0-9A-Z]` charset. One fixture violating both would
   * leave either bound free to be added back alone.
   */
  it("preserves non-SQLSTATE driver codes verbatim — they are not normalised away", () => {
    expect(redactedErrorCode({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(redactedErrorCode({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(redactedErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
    // Mixed case, and longer than five characters.
    expect(redactedErrorCode({ code: "NeonDbError" })).toBe("NeonDbError");
    // Exactly five characters, but lowercase — a charset bound alone kills this
    // one while a length bound alone lets it through.
    expect(redactedErrorCode({ code: "57p01" })).toBe("57p01");

    // The redaction guarantee is untouched by any of that: the code is returned,
    // the `params:` clause in the message never is.
    const outage = Object.assign(
      new Error(
        `getaddrinfo ENOTFOUND ep-example.neon.tech — params: ${SECRET}`,
      ),
      { code: "ENOTFOUND" },
    );
    expect(redactedErrorCode(outage)).toBe("ENOTFOUND");
    expect(redactedErrorCode(outage)).not.toContain(SECRET);
  });

  it("never leaks a thrown non-Error value either", () => {
    expect(redactedErrorCode(`raw string throw carrying ${SECRET}`)).toBe(
      "unknown",
    );
    expect(redactedErrorCode({ code: "57014", detail: SECRET })).toBe("57014");
    expect(redactedErrorCode(undefined)).toBe("unknown");
    expect(redactedErrorCode(null)).toBe("unknown");
  });
});

describe("formatFatalError", () => {
  const CANARY = "leak-canary@example.com";
  const drizzle = () =>
    new DrizzleQueryError(
      `select "id" from "subscriptions" where "email" = $1`,
      [CANARY],
      Object.assign(new Error("relation missing"), { code: "42P01" }),
    );

  it("redacts a DrizzleQueryError to the SQLSTATE and stack frames", () => {
    const err = drizzle();
    expect(err.message).toContain(CANARY);
    const out = formatFatalError(err);
    expect(out).toContain("42P01");
    expect(out).toContain("at ");
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("Failed query");
  });

  it("still redacts when a plain Error wraps the DrizzleQueryError as its cause", () => {
    const out = formatFatalError(
      new Error("lane failed", { cause: drizzle() }),
    );
    expect(out).toContain("database error");
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain("Failed query");
  });

  it("keeps the message of a non-DB Error", () => {
    expect(formatFatalError(new TypeError("boom-visible"))).toContain(
      "boom-visible",
    );
  });

  it("returns a thrown string as-is", () => {
    expect(formatFatalError("plain string throw")).toBe("plain string throw");
  });

  it("terminates on a self-referential cause cycle", () => {
    const err = new Error("cyclic") as Error & { cause?: unknown };
    err.cause = err;
    expect(formatFatalError(err)).toContain("cyclic");
  });

  describe("URI credential scrubbing", () => {
    const PW = "S3cretCanaryPw";

    // neon() itself does not throw; the invalid-URL error surfaces on the first query.
    it("scrubs the password neon() embeds in its invalid-URL error (quoted DATABASE_URL)", async () => {
      let thrown: unknown;
      try {
        const sql = neon(
          `"postgresql://u:${PW}@ep-x.us-east-1.aws.neon.tech/db"`,
        );
        await sql`select 1`;
      } catch (e) {
        thrown = e;
      }
      // Premise: the raw error really carries the secret.
      expect((thrown as Error).message).toContain(PW);
      const out = formatFatalError(thrown);
      expect(out).not.toContain(PW);
      // neon() throws a NeonDbError, which the DB branch already redacts whole
      // (message and host included); the URI scrub is the second layer, pinned below.
      expect(out).toContain("NeonDbError");
    });

    it("scrubs an unquoted URL in a plain Error message", () => {
      const out = formatFatalError(
        new Error(`bad url postgres://user:${PW}@host/db`),
      );
      expect(out).not.toContain(PW);
      expect(out).toContain("host/db");
    });

    it("scrubs a URL in a thrown string", () => {
      const out = formatFatalError(`failed: postgresql://user:${PW}@host/db`);
      expect(out).not.toContain(PW);
      expect(out).toContain("<redacted>@host/db");
    });

    it("scrubs a password containing a raw @ or /", () => {
      const at = formatFatalError(new Error("x postgres://u:p@w@host/db"));
      expect(at).not.toContain("p@w");
      expect(at).not.toContain("w@");
      expect(at).toContain("@host/db");
      const slash = formatFatalError(
        new Error("x postgresql://u:pa/ss@host/db"),
      );
      expect(slash).not.toContain("pa/ss");
      expect(slash).toContain("@host/db");
    });
  });

  it("does not let a param holding a fake stack frame past the frame filter", () => {
    const err = new DrizzleQueryError(
      "select 1 where a = $1",
      ["x\n    at injected-canary (evil.ts:1:1)"],
      Object.assign(new Error("c"), { code: "42P01" }),
    );
    const out = formatFatalError(err);
    expect(out).toContain("database error");
    expect(out).not.toContain("injected-canary");
  });

  it("redacts an AggregateError wrapping a DrizzleQueryError", () => {
    const err = new DrizzleQueryError(
      "select 1 where a = $1",
      [CANARY],
      Object.assign(new Error("c"), { code: "42P01" }),
    );
    const out = formatFatalError(new AggregateError([err], "many"));
    expect(out).toContain("database error");
    expect(out).not.toContain(CANARY);
  });

  it("emits no frames when the stack header does not match name: message", () => {
    const err = new DrizzleQueryError(
      "select 1 where a = $1",
      ["a\nb\n    at injected-canary (evil.ts:1:1)"],
      Object.assign(new Error("c"), { code: "42P01" }),
    );
    err.stack = "Error: mismatch\n    at real (file.ts:1:1)";
    const out = formatFatalError(err);
    expect(out).toContain("database error");
    expect(out).toContain("header mismatch");
    expect(out).not.toContain("injected-canary");
  });

  it("scrubs pathological repeated-scheme input in linear time", () => {
    const start = performance.now();
    formatFatalError(new Error("a://".repeat(50000)));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
