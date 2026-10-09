import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  approvedFacilityId,
  approveBody,
  approveGate,
  formatListEntry,
  parseApproveArgs,
  type ListedSubmission,
} from "./submissions";

const row = (watcherCount: number | undefined, targetFacilityId: string | null = "fac-a") => ({
  id: "sub-1",
  kind: "update",
  targetFacilityId,
  watcherCount,
});

describe("approveGate", () => {
  it("lets a row with no watchers through without the flag", () => {
    expect(approveGate(row(0), false)).toEqual({ ok: true });
  });

  it("refuses a row with watchers when the flag is absent, naming the count, id and facility", () => {
    const gate = approveGate(row(3), false);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe(
      "Refusing: approving sub-1 emails 3 confirmed watcher(s) of fac-a. " +
        "Re-run with --notify-watchers to send."
    );
  });

  it("names the payload.id a create writes, never null, when the create has no targetFacilityId", () => {
    const gate = approveGate(
      { id: "sub-2", kind: "create", targetFacilityId: null, payload: { id: "retired-slug" }, watcherCount: 2 },
      false
    );
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toBe(
      "Refusing: approving sub-2 emails 2 confirmed watcher(s) of retired-slug. " +
        "Re-run with --notify-watchers to send."
    );
  });

  it("lets a row with watchers through when the flag is passed", () => {
    expect(approveGate(row(3), true)).toEqual({ ok: true });
  });

  it("treats a missing watcherCount as unknown and refuses, rather than reading it as 0", () => {
    const gate = approveGate(row(undefined), false);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.reason).toContain("did not report a watcher count");
    expect(gate.reason).toContain("--notify-watchers");
  });

  it("lets a row with an unknown count through when the flag is passed", () => {
    expect(approveGate(row(undefined), true)).toEqual({ ok: true });
  });
});

describe("parseApproveArgs", () => {
  it("returns no note and no opt-in for a bare id", () => {
    expect(parseApproveArgs(["sub-1"])).toEqual({
      id: "sub-1",
      note: undefined,
      notifyWatchers: false,
    });
  });

  it("joins the remaining words into the note", () => {
    expect(parseApproveArgs(["sub-1", "checked", "the", "source"])).toEqual({
      id: "sub-1",
      note: "checked the source",
      notifyWatchers: false,
    });
  });

  it.each([
    ["trailing", ["sub-1", "looks", "right", "--notify-watchers"]],
    ["middle", ["sub-1", "looks", "--notify-watchers", "right"]],
    ["before the id", ["--notify-watchers", "sub-1", "looks", "right"]],
  ])("accepts the flag %s and strips it from the note", (_where, args) => {
    expect(parseApproveArgs(args)).toEqual({
      id: "sub-1",
      note: "looks right",
      notifyWatchers: true,
    });
  });

  it("returns no note when the flag was the only thing after the id", () => {
    expect(parseApproveArgs(["sub-1", "--notify-watchers"])).toEqual({
      id: "sub-1",
      note: undefined,
      notifyWatchers: true,
    });
  });

  it("returns no id when there are no arguments", () => {
    expect(parseApproveArgs([]).id).toBeUndefined();
  });
});

describe("formatListEntry", () => {
  const base: ListedSubmission = {
    id: "sub-1",
    kind: "update",
    status: "pending",
    targetFacilityId: "fac-a",
    createdAt: "2026-10-04T00:00:00.000Z",
    provenance: { sources: ["https://example.com/a"] },
  };

  it("marks a row that would email watchers", () => {
    const lines = formatListEntry({ ...base, watcherCount: 2 });
    expect(lines).toContain("  ⚠ emails 2 confirmed watcher(s) on approve");
  });

  it("prints no marker for a row with zero or unreported watchers", () => {
    expect(formatListEntry({ ...base, watcherCount: 0 })).toHaveLength(2);
    expect(formatListEntry(base)).toHaveLength(2);
  });
});

describe("approveBody", () => {
  it("carries notifyWatchers: true when the flag was passed", () => {
    expect(approveBody("looks fine", true)).toEqual({ reviewNote: "looks fine", notifyWatchers: true });
  });

  it("omits notifyWatchers entirely when the flag was not passed", () => {
    const body = approveBody("looks fine", false);
    expect(body).toEqual({ reviewNote: "looks fine" });
    expect("notifyWatchers" in body).toBe(false);
  });

  it("carries the flag with no note", () => {
    expect(JSON.parse(JSON.stringify(approveBody(undefined, true)))).toEqual({ notifyWatchers: true });
  });
});

describe("approvedFacilityId", () => {
  it("keys a create on payload.id and ignores a stray targetFacilityId", () => {
    expect(
      approvedFacilityId({ kind: "create", targetFacilityId: "fac-a", payload: { id: "retired-slug" } })
    ).toBe("retired-slug");
  });

  it("keys every other kind on targetFacilityId", () => {
    for (const kind of ["update", "status_update", "enrichment_update"]) {
      expect(approvedFacilityId({ kind, targetFacilityId: "fac-a", payload: { id: "other" } })).toBe("fac-a");
    }
  });

  it.each([
    ["a missing payload", { kind: "create", targetFacilityId: "fac-a", payload: undefined }],
    ["a null payload", { kind: "create", targetFacilityId: "fac-a", payload: null }],
    ["no id", { kind: "create", targetFacilityId: "fac-a", payload: {} }],
    ["a non-string id", { kind: "create", targetFacilityId: "fac-a", payload: { id: 42 } }],
    ["an empty id", { kind: "create", targetFacilityId: "fac-a", payload: { id: "" } }],
    ["an update with no target", { kind: "update", targetFacilityId: null, payload: {} }],
  ])("is null for %s", (_name, r) => {
    expect(approvedFacilityId(r)).toBeNull();
  });
});

describe("isMain guard", () => {
  // Runs the real script under tsx. With no API_ADMIN_TOKEN, main() prints a
  // message and exits 1; if the guard wrongly decides the file was imported,
  // nothing runs: no output, exit 0. tmpdir() is realpath'd first (macOS's is a
  // symlink) so each case isolates ONE thing: a space, or a symlink.
  function runCli(entry: string): { stderr: string; status: number | null } {
    const env = { ...process.env };
    delete env.API_ADMIN_TOKEN;
    return spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"), [entry, "list"], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  function withTempDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "submissions-cli-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const source = (): string => join(process.cwd(), "scripts", "submissions.ts");

  it("still runs the CLI when its path contains a space", () => {
    withTempDir((dir) => {
      const nested = join(dir, "dir with space");
      mkdirSync(nested);
      const copy = join(nested, "submissions.ts");
      copyFileSync(source(), copy);
      copyFileSync(join(process.cwd(), "scripts", "is-entrypoint.ts"), join(nested, "is-entrypoint.ts"));

      const run = runCli(copy);
      expect(run.stderr).toContain("API_ADMIN_TOKEN is not set");
      expect(run.status).toBe(1);
    });
  }, 90_000);

  it("still runs the CLI when it is invoked through a symlink", () => {
    withTempDir((dir) => {
      const real = join(dir, "real.ts");
      const link = join(dir, "via-link.ts");
      copyFileSync(source(), real);
      copyFileSync(join(process.cwd(), "scripts", "is-entrypoint.ts"), join(dir, "is-entrypoint.ts"));
      symlinkSync(real, link);

      const run = runCli(link);
      expect(run.stderr).toContain("API_ADMIN_TOKEN is not set");
      expect(run.status).toBe(1);
    });
  }, 90_000);
});
