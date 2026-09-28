import { describe, it, expect } from "vitest";

import { redactedErrorCode } from "@/lib/db-error";

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
  const driverError = Object.assign(new Error(`relation "subscriptions" does not exist`), { code });
  return new Error(
    `Failed query: select "id" from "subscriptions" where "email" = $1 params: ${params}`,
    { cause: driverError }
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
    const err = Object.assign(new Error(`connection terminated — params: ${SECRET}`), {
      code: "08006",
    });

    const redacted = redactedErrorCode(err);

    expect(redacted).toBe("08006");
    expect(redacted).not.toContain(SECRET);
  });

  it("prefers the outer layer's code when both layers carry one", () => {
    const err = Object.assign(drizzleShapedError(SECRET, "42P01"), { code: "23505" });

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
      new Error(`getaddrinfo ENOTFOUND ep-example.neon.tech — params: ${SECRET}`),
      { code: "ENOTFOUND" }
    );
    expect(redactedErrorCode(outage)).toBe("ENOTFOUND");
    expect(redactedErrorCode(outage)).not.toContain(SECRET);
  });

  it("never leaks a thrown non-Error value either", () => {
    expect(redactedErrorCode(`raw string throw carrying ${SECRET}`)).toBe("unknown");
    expect(redactedErrorCode({ code: "57014", detail: SECRET })).toBe("57014");
    expect(redactedErrorCode(undefined)).toBe("unknown");
    expect(redactedErrorCode(null)).toBe("unknown");
  });
});
