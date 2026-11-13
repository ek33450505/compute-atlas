import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PreflightConfigError,
  readOneFacilityReal,
  runPreflight,
  type PreflightDeps,
} from "./preflight";
import { EXIT_GATE_UNAVAILABLE, VERIFY_DISABLED_REFUSAL } from "./submit-candidates";

const okFetch = (async () =>
  new Response(JSON.stringify({ models: [{ name: "m:latest" }] }), { status: 200 })) as typeof fetch;
const failFetch = (async () => {
  throw new Error("down");
}) as typeof fetch;

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: { OLLAMA_VERIFY_MODEL: "m" },
    fetchImpl: okFetch,
    readOneFacility: async () => 1,
    ...over,
  };
}

describe("runPreflight", () => {
  it("passes when every check passes", async () => {
    const r = await runPreflight(deps());
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual([
      "preflight: ok verify_required",
      "preflight: ok ollama",
      "preflight: ok facility_read",
    ]);
  });

  it("exits 1 with the refusal text on a verify violation", async () => {
    const r = await runPreflight(
      deps({ env: { DISCOVERY_REQUIRE_VERIFY: "1", VERIFY_SOURCES_ENABLED: "false" } })
    );
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain(VERIFY_DISABLED_REFUSAL);
  });

  it("skips ollama when the gate is off and not required", async () => {
    const r = await runPreflight(
      deps({ env: { VERIFY_SOURCES_ENABLED: "false" }, fetchImpl: failFetch })
    );
    expect(r.exitCode).toBe(0);
    expect(r.lines).toContain("preflight: skip ollama - verification disabled");
  });

  it("exits 3 when ollama is unreachable", async () => {
    const r = await runPreflight(deps({ fetchImpl: failFetch }));
    expect(r.exitCode).toBe(EXIT_GATE_UNAVAILABLE);
    expect(r.lines).toContain("preflight: FAIL ollama - network_error");
  });

  it("exits 3 on a facility read failure and logs only a code", async () => {
    const secret = "postgres://user:hunter2@host/db";
    const r = await runPreflight(
      deps({
        readOneFacility: async () => {
          throw Object.assign(new Error(`connect failed ${secret}`), { code: "ECONNREFUSED" });
        },
      })
    );
    expect(r.exitCode).toBe(EXIT_GATE_UNAVAILABLE);
    const text = r.lines.join("\n");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("connect failed");
  });

  it("exits 1 when no database URL is configured", async () => {
    const r = await runPreflight(deps({ readOneFacility: async () => null }));
    expect(r.exitCode).toBe(1);
  });

  it("exits 1 on a reader-required refusal", async () => {
    const r = await runPreflight(
      deps({
        readOneFacility: async () => {
          throw new PreflightConfigError("x");
        },
      })
    );
    expect(r.exitCode).toBe(1);
  });

  it("config wins over environmental", async () => {
    const r = await runPreflight(
      deps({
        env: { DISCOVERY_REQUIRE_VERIFY: "1", VERIFY_SOURCES_ENABLED: "false" },
        readOneFacility: async () => {
          throw new Error("boom");
        },
      })
    );
    expect(r.exitCode).toBe(1);
    expect(r.lines.some((l) => l.includes("FAIL facility_read"))).toBe(true);
  });

  it("exits 3 on zero rows", async () => {
    const r = await runPreflight(deps({ readOneFacility: async () => 0 }));
    expect(r.exitCode).toBe(EXIT_GATE_UNAVAILABLE);
    expect(r.lines).toContain("preflight: FAIL facility_read - facilities table empty");
  });

  it("exits 3 on a read timeout", async () => {
    const r = await runPreflight(
      deps({ readOneFacility: () => new Promise(() => {}), readTimeoutMs: 20 })
    );
    expect(r.exitCode).toBe(EXIT_GATE_UNAVAILABLE);
    expect(r.lines).toContain("preflight: FAIL facility_read - timeout");
  });

  it.each(["28P01", "42501", "42P01", "3D000"])("exits 1 on config SQLSTATE %s", async (code) => {
    const r = await runPreflight(
      deps({
        readOneFacility: async () => {
          throw Object.assign(new Error("x"), { code });
        },
      })
    );
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain(code);
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "08006"])("keeps %s environmental", async (code) => {
    const r = await runPreflight(
      deps({
        readOneFacility: async () => {
          throw Object.assign(new Error("x"), { code });
        },
      })
    );
    expect(r.exitCode).toBe(EXIT_GATE_UNAVAILABLE);
  });
});

describe("readOneFacilityReal wiring", () => {
  afterEach(() => vi.unstubAllEnvs());

  const real = () => runPreflight(deps({ readOneFacility: readOneFacilityReal }));

  it("exits 1 when DISCOVERY_REQUIRE_READER=1 and no reader URL", async () => {
    vi.stubEnv("DISCOVERY_REQUIRE_READER", "1");
    vi.stubEnv("DISCOVERY_READ_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost/db");
    expect((await real()).exitCode).toBe(1);
  });

  it("exits 1 when no database URL is set", async () => {
    vi.stubEnv("DISCOVERY_REQUIRE_READER", "");
    vi.stubEnv("DISCOVERY_READ_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    expect((await real()).exitCode).toBe(1);
  });

  it("exits 1 on a malformed URL without echoing it", async () => {
    vi.stubEnv("DISCOVERY_REQUIRE_READER", "");
    vi.stubEnv("DISCOVERY_READ_DATABASE_URL", "not a url hunter2");
    const r = await real();
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).not.toContain("hunter2");
  });

  it("exits 1 on a non-postgres URL", async () => {
    vi.stubEnv("DISCOVERY_REQUIRE_READER", "");
    vi.stubEnv("DISCOVERY_READ_DATABASE_URL", "https://example.com/db");
    expect((await real()).exitCode).toBe(1);
  });
});
