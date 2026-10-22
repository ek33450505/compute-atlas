import { afterEach, describe, it, expect, vi } from "vitest";

import { hashAddress } from "../lib/email-sends";
import { UsageError, parseArgs, runCli, type CliDeps } from "./email-sends";

const ADDRESS = "Secret.Reader@example.com";

function makeDeps(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    readStdin: () => `${ADDRESS}\n`,
    query: vi.fn(async () => ({
      rows: [
        {
          id: "r1",
          createdAt: new Date("2026-10-01T12:00:00Z"),
          completedAt: null,
          kind: "confirm",
          outcome: "sent",
          targetType: null,
          targetId: null,
          runId: null,
          resendId: "re_1",
          errorCode: null,
          subscriptionId: null,
          hashPrefix: "abcd1234",
        },
      ],
      counts: { sent: 1 },
    })),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...overrides,
  };
  return { deps, out, err };
}

describe("parseArgs", () => {
  it("parses every flag", () => {
    expect(
      parseArgs([
        "--email", "-", "--run", "11111111-1111-4111-8111-111111111111",
        "--kind", "confirm", "--outcome", "sent", "--since", "2026-10-01", "--limit", "5",
      ])
    ).toEqual({
      email: "-",
      run: "11111111-1111-4111-8111-111111111111",
      kind: "confirm",
      outcome: "sent",
      since: "2026-10-01",
      limit: 5,
    });
  });

  it.each([
    [["--bogus", "x"]],
    [["--kind", "nope"]],
    [["--outcome", "nope"]],
    [["--since", "2026-02-31"]],
    [["--run", "abc"]],
    [["--limit", "0"]],
    [["--limit", "501"]],
    [["--kind"]],
    [["--email", "--kind", "confirm"]],
    [["--since", "--limit", "5"]],
    [["positional"]],
  ])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe("parseArgs flag-value guard", () => {
  it.each([
    [["--email", "--kind", "confirm"], "--email needs a value"],
    [["--since", "--limit", "5"], "--since needs a value"],
    // Without the guard these PARSE successfully (the next flag becomes the value), so only the guard rejects them.
    [["--kind", "confirm", "--email", "--limit"], "--email needs a value"],
    [["--email", "--run"], "--email needs a value"],
  ])("rejects %j with %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(new UsageError(message));
  });
});

describe("runCli", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exits 1 with usage on a bad flag and does not query", async () => {
    const { deps, err } = makeDeps();
    expect(await runCli(["--bogus", "x"], deps)).toBe(1);
    expect(err.join("\n")).toContain("Usage:");
    expect(deps.query).not.toHaveBeenCalled();
  });

  it("reads the address from stdin for --email -, queries by its hash, and never prints it", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "test-salt");
    const { deps, out, err } = makeDeps();
    expect(await runCli(["--email", "-"], deps)).toBe(0);
    expect(deps.query).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: hashAddress(ADDRESS) })
    );
    const printed = [...out, ...err].join("\n");
    expect(printed).toContain("address: <provided, hashed>");
    expect(printed.toLowerCase()).not.toContain("secret.reader");
    expect(printed).not.toContain(hashAddress(ADDRESS));
    expect(printed).toContain("abcd1234");
    expect(printed).toContain("sent=1");
  });

  it("never echoes an address passed as a flag value", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "test-salt");
    const { deps, out, err } = makeDeps();
    await runCli(["--email", ADDRESS], deps);
    expect([...out, ...err].join("\n").toLowerCase()).not.toContain("secret.reader");
  });

  it("refuses an address lookup with exit 2 when the salt is unset, and never queries", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "");
    const { deps, err } = makeDeps();
    expect(await runCli(["--email", "-"], deps)).toBe(2);
    expect(err.join("\n")).toContain("needs CONTRIBUTE_IP_SALT");
    expect(err.join("\n").toLowerCase()).not.toContain("secret.reader");
    expect(deps.query).not.toHaveBeenCalled();
  });

  it("still runs non-address filters with the salt unset", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "");
    const { deps } = makeDeps();
    expect(await runCli(["--kind", "confirm"], deps)).toBe(0);
    expect(deps.query).toHaveBeenCalled();
  });

  it("warns in the usage text that --email <addr> stays in shell history", async () => {
    const { deps, err } = makeDeps();
    await runCli(["--bogus", "x"], deps);
    expect(err.join("\n")).toContain("stays in shell history");
  });

  it("rejects a non-address --email without echoing it and without querying", async () => {
    const { deps, err } = makeDeps();
    expect(await runCli(["--email", "notanaddress"], deps)).toBe(1);
    expect(err.join("\n")).not.toContain("notanaddress");
    expect(deps.query).not.toHaveBeenCalled();
  });

  it("reports a query failure by code only", async () => {
    vi.stubEnv("CONTRIBUTE_IP_SALT", "test-salt");
    const { deps, err } = makeDeps({
      query: vi.fn(async () => {
        throw Object.assign(new Error(`Failed query params: ${ADDRESS}`), { code: "57P01" });
      }),
    });
    expect(await runCli(["--email", ADDRESS], deps)).toBe(1);
    expect(err.join("\n").toLowerCase()).not.toContain("secret.reader");
  });
});
