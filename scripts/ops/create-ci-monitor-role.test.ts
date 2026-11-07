// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertSafePassword,
  buildCiUrl,
  buildPlan,
  generatePassword,
  GRANTED_TABLES,
  parseCliArgs,
  run,
  runGuarded,
  verifyRole,
  type RunDeps,
  type Sql,
} from "./create-ci-monitor-role";

describe("parseCliArgs", () => {
  it("is a dry run by default", () => {
    expect(parseCliArgs([])).toEqual({
      apply: false,
      rotate: false,
      out: null,
    });
  });
  it("requires --out with --apply", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow(/--out/);
    expect(parseCliArgs(["--apply", "--out", "/x"])).toEqual({
      apply: true,
      rotate: false,
      out: "/x",
    });
  });
  it("rejects --out on a dry run and unknown flags", () => {
    expect(() => parseCliArgs(["--out", "/x"])).toThrow();
    expect(() => parseCliArgs(["--bogus"])).toThrow();
  });
  it("--rotate is an independent opt-in", () => {
    expect(parseCliArgs(["--apply", "--rotate", "--out", "/x"]).rotate).toBe(
      true,
    );
    expect(parseCliArgs([]).rotate).toBe(false);
  });
});

describe("buildCiUrl", () => {
  it("keeps host, db and params; swaps credentials", () => {
    const url = new URL(
      buildCiUrl(
        "postgresql://neondb_owner:ownerpw@ep-x.neon.tech/neondb?sslmode=require",
        "p@ss/w+rd",
      ),
    );
    expect(url.username).toBe("ci_monitor");
    expect(decodeURIComponent(url.password)).toBe("p@ss/w+rd");
    expect(url.host).toBe("ep-x.neon.tech");
    expect(url.pathname).toBe("/neondb");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.toString()).not.toContain("ownerpw");
  });
  it("generates URL-safe, SQL-literal-safe passwords with all character classes", () => {
    const pw = generatePassword();
    expect(pw).toMatch(/^[A-Za-z0-9_-]{43}-Aa1$/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(generatePassword()).not.toBe(pw);
  });
});

describe("assertSafePassword", () => {
  it("accepts a generated password", () => {
    expect(() => assertSafePassword(generatePassword())).not.toThrow();
  });
  it.each(["a'b".padEnd(45, "x"), `${"x".repeat(45)}'; DROP ROLE x; --`, "short", "x".repeat(45) + "\\"])(
    "rejects %s",
    (bad) => {
      expect(() => assertSafePassword(bad)).toThrow(/unexpected shape/);
    },
  );
});

const SAFE_PW = "x".repeat(43) + "-Aa1";

describe("buildPlan", () => {
  it("refuses to interpolate an unchecked password", () => {
    expect(() => buildPlan('"d"', `${SAFE_PW}'; DROP ROLE x; --`, false)).toThrow(/unexpected shape/);
  });
  it("lists the privilege statements and only the redacted password", () => {
    const plan = buildPlan('"neondb"', "<redacted>", "unknown").join("\n");
    expect(plan).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ci_monitor",
    );
    expect(plan).toContain('GRANT CONNECT ON DATABASE "neondb" TO ci_monitor');
    expect(plan).toContain("GRANT USAGE ON SCHEMA public TO ci_monitor");
    expect(plan).toContain(
      `GRANT SELECT ON ${GRANTED_TABLES.join(", ")} TO ci_monitor`,
    );
    expect(plan).toContain("default_transaction_read_only = on");
    expect(plan).toContain("statement_timeout = '30s'");
    expect(plan).toContain("PASSWORD '<redacted>'");
  });
  it("creates or alters depending on role existence", () => {
    expect(buildPlan('"d"', SAFE_PW, false)[0]).toMatch(
      /^CREATE ROLE ci_monitor LOGIN/,
    );
    expect(buildPlan('"d"', SAFE_PW, true)[0]).toMatch(
      /^ALTER ROLE ci_monitor LOGIN/,
    );
  });
});

// ---------------------------------------------------------------------------
// run() / verifyRole() with a mocked db layer
// ---------------------------------------------------------------------------

const SENTINEL = "SENTINEL-owner-pw-9f3";
const OWNER = `postgresql://neondb_owner:${SENTINEL}@ep-x.neon.tech/neondb?sslmode=require`;

interface Harness {
  deps: RunDeps;
  out: string[];
  err: string[];
  statements: string[];
  connectedUrls: string[];
}

function harness(opts: {
  roleExists?: boolean;
  failOn?: RegExp;
  failWith?: Error;
  verifyRows?: Record<string, unknown[]>;
}): Harness {
  const h: Harness = { deps: undefined as never, out: [], err: [], statements: [], connectedUrls: [] };
  const ownerSql: Sql = {
    query: async (text: string) => {
      h.statements.push(text);
      if (opts.failOn?.test(text)) throw opts.failWith ?? new Error("boom");
      if (text.includes("quote_ident")) return [{ q: '"neondb"' }];
      if (text.includes("FROM pg_roles")) return opts.roleExists ? [{ one: 1 }] : [];
      if (text.includes("count(*)")) return [{ n: 19 }];
      return [];
    },
  };
  const ciSql: Sql = {
    query: async (text: string) => {
      if (text.startsWith("INSERT")) throw Object.assign(new Error("denied"), { code: "42501" });
      if (text.startsWith("SELECT 1 FROM")) return [{}];
      if (text.includes("has_table_privilege(current_user, 'public.api_daily_usage'")) return [{ p: false }];
      if (text.includes("has_table_privilege(current_user, c.oid")) {
        return (opts.verifyRows?.rel ?? GRANTED_TABLES.map((relname) => ({ relname }))) as unknown[];
      }
      if (text.includes("has_database_privilege")) return opts.verifyRows?.db ?? [{ p: false }];
      if (text.includes("has_schema_privilege")) return opts.verifyRows?.schema ?? [{ p: false }];
      if (text.includes("pg_auth_members")) return opts.verifyRows?.members ?? [{ n: 0 }];
      if (text.includes("pg_tables")) return Array.from({ length: 19 }, (_, i) => ({ tablename: `t${i}` }));
      return [];
    },
  };
  h.deps = {
    connect: (url) => {
      h.connectedUrls.push(url);
      return url.includes("ci_monitor") ? ciSql : ownerSql;
    },
    log: (l) => h.out.push(l),
    error: (l) => h.err.push(l),
  };
  return h;
}

function tmpOut(): string {
  return join(mkdtempSync(join(tmpdir(), "ci-monitor-test-")), "ci.url");
}

describe("run", () => {
  it("dry run connects to nothing and prints a redacted plan", async () => {
    const h = harness({});
    expect(await run([], {}, h.deps)).toBe(0);
    expect(h.connectedUrls).toEqual([]);
    expect(h.out.join("\n")).toContain("PASSWORD '<redacted>'");
  });

  it("apply: writes a 0600 URL file with no trailing newline and never prints it", async () => {
    const h = harness({});
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(0);
    const url = readFileSync(out, "utf8");
    expect(url.endsWith("\n")).toBe(false);
    expect(new URL(url).username).toBe("ci_monitor");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const printed = [...h.out, ...h.err].join("\n");
    expect(printed).not.toContain(new URL(url).password);
    expect(printed).not.toContain(SENTINEL);
    const create = h.statements.find((s) => s.startsWith("CREATE ROLE ci_monitor"));
    expect(create).toContain(`PASSWORD '${new URL(url).password}'`);
    expect(create).not.toContain("SCRAM-SHA-256$");
    expect(h.out.filter((l) => l.startsWith("PASS"))).toHaveLength(10);
    expect(h.out.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  });

  it("refuses to overwrite an existing --out file and touches no SQL", async () => {
    const h = harness({});
    const out = tmpOut();
    writeFileSync(out, "precious");
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("precious");
    expect(h.statements).toEqual([]);
  });

  it("existing role without --rotate is refused and the file is removed", async () => {
    const h = harness({ roleExists: true });
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("--rotate");
    expect(existsSync(out)).toBe(false);
    expect(h.statements.some((s) => s.includes("PASSWORD"))).toBe(false);
  });

  it("existing role with --rotate issues ALTER ROLE", async () => {
    const h = harness({ roleExists: true });
    const out = tmpOut();
    expect(await run(["--apply", "--rotate", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(0);
    expect(h.statements.some((s) => s.startsWith("ALTER ROLE ci_monitor LOGIN"))).toBe(true);
    expect(existsSync(out)).toBe(true);
  });

  it("a driver error echoing the plaintext password prints only the code", async () => {
    let password = "";
    const h = harness({ failOn: /^CREATE ROLE/ });
    const real = h.deps.connect;
    h.deps.connect = (url) => {
      const sql = real(url);
      return {
        query: async (text: string) => {
          try {
            return await sql.query(text);
          } catch {
            password = /PASSWORD '([^']+)'/.exec(text)?.[1] ?? "";
            throw Object.assign(new Error(`Failed query: ${text}`), { code: "XX000" });
          }
        },
      };
    };
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(password.length).toBeGreaterThan(40);
    expect(existsSync(out)).toBe(false);
    const printed = [...h.out, ...h.err].join("\n");
    expect(printed).toContain("XX000");
    expect(printed).not.toContain(password);
    expect(printed).not.toContain("PASSWORD");
  });

  it("SQL failure removes the file and prints only the code, never the statement", async () => {
    const h = harness({
      failOn: /^GRANT CONNECT/,
      failWith: Object.assign(new Error("Failed query: GRANT ... LEAK"), {
        code: "42501",
      }),
    });
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(existsSync(out)).toBe(false);
    const printed = h.err.join("\n");
    expect(printed).toContain("42501");
    expect(printed).not.toContain("LEAK");
  });

  it("an unsafe generated password fails before any SQL, with no secret in the output", async () => {
    const h = harness({});
    const bad = `${"x".repeat(45)}'; DROP ROLE x; --`;
    h.deps.generatePassword = () => bad;
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(h.statements).toEqual([]);
    expect(h.connectedUrls).toEqual([]);
    expect(existsSync(out)).toBe(false);
    const printed = [...h.out, ...h.err].join("\n");
    expect(printed).not.toContain("DROP ROLE");
    expect(printed).not.toContain(SENTINEL);
  });

  it("a malformed DATABASE_URL never echoes the input", async () => {
    const h = harness({});
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: `not a url ${SENTINEL}` }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toBe("DATABASE_URL is not a valid URL");
    expect(h.err.join("\n")).not.toContain(SENTINEL);
    expect(existsSync(out)).toBe(false);
  });

  it("a failed verification exits 1, keeps the file and says which check failed", async () => {
    const h = harness({ verifyRows: { schema: [{ p: true }] } });
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    expect(h.out).toContain("FAIL  no CREATE on schema public");
    expect(existsSync(out)).toBe(true);
  });
});

describe("verifyRole boundary checks", () => {
  const sqlWith = (rows: Record<string, unknown[]>): Sql => harness({ verifyRows: rows }).deps.connect("x/ci_monitor");
  it("fails when an extra relation is SELECT-able", async () => {
    const rel = [...GRANTED_TABLES, "facilities"].map((relname) => ({ relname }));
    const res = await verifyRole(sqlWith({ rel }), 19);
    expect(res.find((r) => r.name.startsWith("SELECT-able"))?.ok).toBe(false);
  });
  it("fails when the role can CREATE on the database", async () => {
    const res = await verifyRole(sqlWith({ db: [{ p: true }] }), 19);
    expect(res.find((r) => r.name === "no CREATE on the database")?.ok).toBe(false);
  });
  it("queries sequences and foreign tables in the relation check", async () => {
    const seen: string[] = [];
    const sql: Sql = {
      query: async (text) => {
        seen.push(text);
        return [];
      },
    };
    await verifyRole(sql, 19);
    expect(seen.find((q) => q.includes("c.relkind IN"))).toContain("'S', 'f'");
  });
  it("fails when the role is a member of another role", async () => {
    const res = await verifyRole(sqlWith({ members: [{ n: 1 }] }), 19);
    expect(res.find((r) => r.name === "member of no role")?.ok).toBe(false);
  });
  it("passes every check on the expected boundary", async () => {
    expect((await verifyRole(sqlWith({}), 19)).every((r) => r.ok)).toBe(true);
  });
});

describe("secret-bearing throws never reach stderr", () => {
  it("neon(ownerUrl) throwing with the input in its message prints only a code", async () => {
    const h = harness({});
    h.deps.connect = () => {
      throw Object.assign(new TypeError(`Invalid URL: ${OWNER}`), { code: "ERR_INVALID_URL" });
    };
    const out = tmpOut();
    expect(await run(["--apply", "--out", out], { DATABASE_URL: OWNER }, h.deps)).toBe(1);
    const printed = h.err.join("\n");
    expect(printed).toContain("ERR_INVALID_URL");
    expect(printed).not.toContain(SENTINEL);
    expect(existsSync(out)).toBe(false);
  });

  it("runGuarded backstops an unhandled throw from run()", async () => {
    const h = harness({});
    h.deps.log = () => {
      throw new Error(`leak ${SENTINEL}`);
    };
    expect(await runGuarded([], {}, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/^unexpected failure \(unknown\)$/);
    expect(h.err.join("\n")).not.toContain(SENTINEL);
  });
});
