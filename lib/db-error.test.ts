import { describe, it, expect } from "vitest";

import { neon } from "@neondatabase/serverless";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { formatErrorSummary, formatFatalError, redactedErrorCode } from "@/lib/db-error";

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
   * that "fixes" it. The guard is `CODE_PATTERN`, `/^[A-Z0-9_]{2,40}$/`: any
   * identifier-shaped code is returned, anything else is "unknown". A review of
   * this helper proposed tightening it to the strict SQLSTATE regex
   * `/^[0-9A-Z]{5}$/`. That is a regression twice over:
   *
   *  - **neon-http** does not always surface a 5-char SQLSTATE, so the regex
   *    would blank out the only discriminator those errors carry — every DB
   *    failure on the production driver would log "unknown".
   *  - it coerces Node's and undici's own network codes to "unknown",
   *    `ENOTFOUND` included. On this project `ENOTFOUND` is specifically the
   *    recorded discriminator between a network/DNS outage and genuine link rot
   *    in a cited source URL; losing it makes "the internet was down" and "this
   *    citation is dead" the same log line.
   *
   * The identifier shape (rather than `typeof === "string"`) is what keeps a
   * `code` property someone filled with free text from reaching a log. The leak
   * this helper exists to stop lives in `.message`, which is never read at all.
   *
   * The fixtures PASS `CODE_PATTERN` and each fail exactly one half of the
   * strict regex: `ENOTFOUND` passes the charset but not the `{5}` length, and
   * `AB_12` passes the length but not the `[0-9A-Z]` charset (it holds `_`).
   * One fixture violating both would leave either bound free to be added back
   * alone.
   */
  it("preserves identifier-shaped driver codes (SQLSTATE and Node/undici network codes)", () => {
    // Length half of the strict regex.
    expect(redactedErrorCode({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(redactedErrorCode({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(redactedErrorCode({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
    // Charset half: exactly five characters, but contains `_`.
    expect(redactedErrorCode({ code: "AB_12" })).toBe("AB_12");
    // A real long underscore code.
    expect(redactedErrorCode({ code: "UND_ERR_SOCKET" })).toBe("UND_ERR_SOCKET");
    expect(redactedErrorCode({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(redactedErrorCode({ code: "42P01" })).toBe("42P01");
  });

  it('returns "unknown" for codes outside CODE_PATTERN, so a crafted code carries no data', () => {
    // Identifier-shaped, but lowercase / mixed case is outside CODE_PATTERN.
    expect(redactedErrorCode({ code: "NeonDbError" })).toBe("unknown");
    expect(redactedErrorCode({ code: "57p01" })).toBe("unknown");
    // Free text.
    expect(redactedErrorCode({ code: "victim@example.com" })).toBe("unknown");
    expect(redactedErrorCode({ code: "x".repeat(41) })).toBe("unknown");
  });

  it("returns the code but never the params in the message", () => {
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
    // Guards against a quadratic blow-up, not speed: the bound is generous so a
    // loaded CI runner cannot flake it.
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("inspectDbError bounds fail closed (via both helpers)", () => {
  const CANARY = "deep-canary@example.com";
  const drizzle = () =>
    new DrizzleQueryError(`select 1 where "email" = $1`, [CANARY], new Error("x"));
  const chain = (depth: number) => {
    let err: Error = drizzle();
    for (let i = 0; i < depth; i++) err = new Error(`wrap ${i}`, { cause: err });
    return err;
  };

  it("redacts a 7-deep cause chain with the neutral limit label (the DrizzleQueryError is never reached)", () => {
    const err = chain(7);
    for (const out of [formatFatalError(err), formatErrorSummary(err)]) {
      expect(out).toContain("inspection limit reached — message redacted");
      expect(out).not.toContain("database error");
      expect(out).not.toContain(CANARY);
    }
  });

  it("redacts with the neutral limit label when the node cap is hit with objects left uninspected", () => {
    const wide = new AggregateError([
      ...Array.from({ length: 30 }, (_, i) => new Error(`e${i}`)),
      drizzle(),
    ]);
    expect(formatErrorSummary(wide)).toContain("inspection limit reached — message redacted");
    expect(formatErrorSummary(wide)).not.toContain("database error");
    expect(formatFatalError(wide)).not.toContain(CANARY);
  });

  it("does not over-redact a shallow benign chain", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(formatErrorSummary(err)).toBe("Error: outer");
  });

  it("recognises a thrown primitive string carrying DB text", () => {
    const thrown = `Failed query: select 1 params: ${CANARY}`;
    for (const out of [formatFatalError(thrown), formatErrorSummary(thrown)]) {
      expect(out).not.toContain(CANARY);
    }
    const params = `boom\nparams: ${CANARY}`;
    expect(formatErrorSummary(params)).not.toContain(CANARY);
    expect(formatFatalError(params)).not.toContain(CANARY);
  });

  it("recognises DB text in a primitive-string cause", () => {
    const err = new Error("outer", { cause: `Failed query: x params: ${CANARY}` });
    expect(formatErrorSummary(err)).toContain("database error");
  });
});

describe("formatErrorSummary: object values must be tokens", () => {
  it("never prints free text from code, name or type", () => {
    for (const obj of [
      { code: "victim@example.com" },
      { name: "victim@example.com" },
      { type: "user a@b.com" },
      { syscall: "a b@c.com" },
      { errno: "a@b.com", status: "a@b.com", statusCode: NaN },
    ]) {
      const out = formatErrorSummary(obj);
      expect(out, JSON.stringify(obj)).not.toMatch(/@/);
      expect(out).toBe("[non-Error object]");
    }
  });

  it("keeps token values and finite numbers", () => {
    expect(formatErrorSummary({ name: "FetchError", type: "system", code: "ECONNRESET", status: 502 })).toBe(
      "object {name: FetchError, type: system, code: ECONNRESET, status: 502}"
    );
  });
});

describe("codes found through the bounded chain walk", () => {
  const drizzle = () =>
    new DrizzleQueryError("select 1", ["p"], Object.assign(new Error("x"), { code: "42P01" }));

  it("redactedErrorCode reads a code one layer below a plain wrapper and inside an AggregateError", () => {
    expect(redactedErrorCode(new Error("lane failed", { cause: drizzle() }))).toBe("42P01");
    expect(redactedErrorCode(new AggregateError([drizzle()]))).toBe("42P01");
  });

  it("both helpers print the sqlstate from there", () => {
    for (const err of [new Error("lane failed", { cause: drizzle() }), new AggregateError([drizzle()])]) {
      expect(formatErrorSummary(err)).toContain("sqlstate: 42P01");
      expect(formatFatalError(err)).toContain("sqlstate: 42P01");
    }
  });

  it("prefers the SQLSTATE over an outer wrapper's own code in a DB header", () => {
    for (const code of ["EPIPE", "LANE_FAILED"]) {
      const wrapped = Object.assign(new Error("lane failed", { cause: drizzle() }), { code });
      for (const out of [formatErrorSummary(wrapped), formatFatalError(wrapped)]) {
        expect(out).toContain("sqlstate: 42P01");
      }
      // The standalone helper stays outermost-first.
      expect(redactedErrorCode(wrapped)).toBe(code);
    }
  });

  it("takes the DB node's code by provenance: outer ABORT wrapping a DrizzleQueryError -> 42P01", () => {
    const outer = Object.assign(new Error("w", { cause: drizzle() }), { code: "ABORT" });
    for (const out of [formatErrorSummary(outer), formatFatalError(outer)]) {
      expect(out).toContain("sqlstate: 42P01");
      expect(out).not.toContain("ABORT");
    }
  });

  it("labels a non-SQLSTATE token as code:, via the walk fallback", () => {
    const err = new DrizzleQueryError("select 1", ["p"], Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect(formatErrorSummary(err)).toContain("(code: ENOTFOUND)");
    expect(formatErrorSummary(err)).not.toContain("sqlstate: ENOTFOUND");
    // No DB node of its own code and no cause code: the walk still finds a token.
    const wrapper = Object.assign(new Error("w", { cause: new DrizzleQueryError("q", ["p"], new Error("y")) }), {
      code: "ECONNRESET",
    });
    expect(formatErrorSummary(wrapper)).toContain("code: ECONNRESET");
  });

  it("prints sqlstate: unknown, never the crafted value, for a non-token code under a DrizzleQueryError", () => {
    const err = new DrizzleQueryError("select 1", ["p"], Object.assign(new Error("x"), { code: "a@b.com" }));
    const out = formatErrorSummary(err);
    expect(out).toContain("sqlstate: unknown");
    expect(out).not.toContain("a@b.com");
  });

  it("leaves a plain network ENOTFOUND unchanged", () => {
    const err = Object.assign(new TypeError("fetch failed"), { code: "ENOTFOUND" });
    expect(formatErrorSummary(err)).toBe("TypeError: fetch failed (code: ENOTFOUND)");
    expect(redactedErrorCode(err)).toBe("ENOTFOUND");
  });

  it("never returns a value outside CODE_PATTERN, at any depth", () => {
    const inner = Object.assign(new Error("x"), { code: "free text a@b.com" });
    expect(redactedErrorCode(new Error("o", { cause: inner }))).toBe("unknown");
  });

  it("lists distinct child codes of a network-only AggregateError, at most 5", () => {
    const net = (code: string) => Object.assign(new Error("connect failed"), { code });
    const agg = new AggregateError([net("ECONNREFUSED"), net("ENOTFOUND"), net("ECONNREFUSED")], "All promises were rejected");
    expect(formatErrorSummary(agg)).toBe("AggregateError: All promises were rejected (codes: ECONNREFUSED, ENOTFOUND)");
    const many = new AggregateError(["EA", "EB", "EC", "ED", "EE", "EF", "EG"].map(net));
    expect(formatErrorSummary(many)).toContain("(codes: EA, EB, EC, ED, EE)");
  });
});

describe("raw pg errors and SQLSTATE-shaped codes", () => {
  const CANARY = "a-b@example.com";

  it("redacts a raw pg-shaped Error (no Drizzle wrapper) by its SQLSTATE code", () => {
    const err = Object.assign(new Error(`invalid input syntax for type uuid: "${CANARY}"`), {
      name: "error",
      code: "22P02",
    });
    for (const out of [formatErrorSummary(err), formatFatalError(err)]) {
      expect(out).toContain("database error");
      expect(out).toContain("22P02");
      expect(out).not.toContain(CANARY);
    }
  });

  it("redacts a SQLSTATE-coded error found on a cause", () => {
    const inner = Object.assign(new Error(`bad "${CANARY}"`), { code: "23505" });
    expect(formatErrorSummary(new Error("outer", { cause: inner }))).not.toContain(CANARY);
  });

  it("redacts the pg echo text even without a code", () => {
    expect(formatErrorSummary(new Error(`invalid input syntax for type uuid: "${CANARY}"`))).not.toContain(CANARY);
  });

  it("never classifies Node errno codes as DB errors", () => {
    for (const code of ["EPIPE", "EBUSY", "EPERM", "EBADF", "ENXIO"]) {
      const out = formatErrorSummary(Object.assign(new Error("io failed"), { code }));
      expect(out).toBe(`Error: io failed (code: ${code})`);
    }
  });
});

describe("formatErrorSummary", () => {
  it("keeps every line of a multi-line Error message and no stack frames", () => {
    const out = formatErrorSummary(new TypeError("Validation failed:\n- a\n- b"));
    expect(out).toBe("TypeError: Validation failed:\n- a\n- b");
    expect(out).not.toMatch(/\n\s+at /);
  });

  it("renders a non-Error object through an allowlist, keeping its code", () => {
    expect(formatErrorSummary({ code: "ENOTFOUND" })).toBe("object {code: ENOTFOUND}");
    expect(formatErrorSummary({ code: "ECONNRESET", errno: -54, other: "dropped" })).toBe(
      "object {code: ECONNRESET, errno: -54}"
    );
  });

  it("emits [non-Error object] when no allowlisted key is present, and skips long or DB-text values", () => {
    expect(formatErrorSummary({ big: "x".repeat(2000) })).toBe("[non-Error object]");
    expect(formatErrorSummary({ code: "x".repeat(101) })).toBe("[non-Error object]");
    expect(formatErrorSummary({ type: "Failed query: a params: leak@x.com" })).toBe("[non-Error object]");
    expect(formatErrorSummary([1, 2])).toBe("[non-Error object]");
  });

  it("never prints the params of a {query, params} object", () => {
    const out = formatErrorSummary({ query: "select 1", params: ["victim@example.com"], code: "X1" });
    expect(out).not.toContain("victim@example.com");
    expect(out).toContain("database error");
  });

  it("never leaks part of a URI credential near any length boundary", () => {
    for (const n of [0, 1, 50, 85, 90, 95, 99, 100, 101, 1990, 1995, 2000, 2005]) {
      const uri = "postgres://user:SECRETPW@host/db";
      const msg = "a".repeat(n) + " " + uri;
      for (const out of [
        formatErrorSummary(new Error(msg)),
        formatErrorSummary({ code: msg }),
        formatErrorSummary({ name: msg.slice(0, 100) }),
      ]) {
        expect(out).not.toContain("SECRETPW");
        expect(out).not.toContain("user:");
      }
    }
  });

  it("appends a bare-token code from the error or its cause chain", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
    expect(formatErrorSummary(err)).toBe("TypeError: fetch failed (code: ENOTFOUND; cause: x)");
  });

  it("ignores a code that is not a bare token", () => {
    const err = Object.assign(new Error("boom"), { code: "secret value@x.com" });
    expect(formatErrorSummary(err)).toBe("Error: boom");
  });

  it("caps the message at 2000 chars, scrubbing before slicing", () => {
    for (let pad = 1970; pad <= 2000; pad++) {
      const err = new Error("a".repeat(pad) + " postgres://u:CUTPW@h/db " + "b".repeat(100));
      const out = formatErrorSummary(err);
      expect(out, `pad ${pad}`).not.toContain("CUT");
      expect(out.length).toBeLessThanOrEqual(2110);
    }
    expect(formatErrorSummary(new Error("a".repeat(5000))).length).toBeLessThan(2200);
  });

  it("labels a cap-tripped, unconfirmed chain honestly", () => {
    let err: Error = new Error("bottom");
    for (let i = 0; i < 7; i++) err = new Error(`w${i}`, { cause: err });
    const out = formatErrorSummary(err);
    expect(out).toContain("inspection limit reached — message redacted");
    expect(out).not.toContain("database error");
    expect(out).not.toContain("w0");
  });

  it("redacts Postgres DETAIL / unique-violation text from a rethrown message", () => {
    const detail = new Error("duplicate key\nDETAIL:  Key (email)=(victim@example.com) already exists.");
    expect(formatErrorSummary(detail)).not.toContain("victim@example.com");
    expect(formatErrorSummary(new Error("DETAIL: leak@example.com"))).not.toContain("leak@");
    const key = new Error("Key (email)=(victim@example.com) already exists");
    expect(formatErrorSummary(key)).not.toContain("victim@example.com");
    expect(formatErrorSummary(new Error("Key (a) is fine"))).toBe("Error: Key (a) is fine");
  });

  it("finishes fast on a 100k-element AggregateError and fails closed with the neutral label", () => {
    const wide = new AggregateError(Array.from({ length: 100_000 }, (_, i) => new Error(`e${i}`)));
    const t = Date.now();
    const out = formatErrorSummary(wide);
    // Guards against a quadratic blow-up (100k children), not speed.
    expect(Date.now() - t).toBeLessThan(5000);
    expect(out).toContain("inspection limit reached — message redacted");
  });

  it("fails closed on a wide array even when every element is the same object", () => {
    const same = new Error("same");
    const wide = new AggregateError(Array.from({ length: 100_000 }, () => same));
    expect(formatErrorSummary(wide)).toContain("inspection limit reached — message redacted");
  });

  it("keeps 'possible database error' when a DB-ish layer was seen before the cap", () => {
    const pg = Object.assign(new Error("e"), { name: "PostgresError" });
    const wide = new AggregateError([pg, ...Array.from({ length: 30 }, (_, i) => new Error(`n${i}`))]);
    const out = formatErrorSummary(wide);
    expect(out).toContain("possible database error (inspection limit reached)");
    const hinted = new AggregateError([Object.assign(new Error("e"), { severity: "ERROR" }), ...Array.from({ length: 30 }, () => new Error("n"))]);
    expect(formatErrorSummary(hinted)).toContain("possible database error");
  });

  it("falls back safely for throwing getters and renders primitives", () => {
    const evil = { get code(): string { throw new Error("nope"); } };
    expect(formatErrorSummary(evil)).toBe("unprintable error");
    expect(formatErrorSummary(42)).toBe("42");
    expect(formatErrorSummary(undefined)).toBe("undefined");
  });

  it("scrubs a credential whose password holds a quote (whole-text pass)", () => {
    const out = formatErrorSummary(new Error('connect postgres://u:p"wSECRET@h/db failed'));
    expect(out).not.toContain("SECRET");
    expect(out).toContain("<redacted>@h/db");
  });

  it("scrubs URI credentials in primitives and Error messages", () => {
    expect(formatErrorSummary(new Error("bad url postgres://u:pw@host/db"))).not.toContain("pw@");
    expect(formatErrorSummary("postgres://u:pw@host/db")).not.toContain(":pw@");
  });
});
