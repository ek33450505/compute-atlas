import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isEntrypoint } from "./is-entrypoint";

let root: string;
let file: string;
let spaced: string;

beforeAll(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "is-entry-"));
  file = join(root, "real.ts");
  writeFileSync(file, "");
  spaced = join(root, "has space");
  mkdirSync(spaced);
  writeFileSync(join(spaced, "s.ts"), "");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("isEntrypoint", () => {
  it("is true for the real path", () => {
    expect(isEntrypoint(pathToFileURL(file).href, file)).toBe(true);
  });

  it("is true through a symlink", () => {
    const link = join(root, "link.ts");
    symlinkSync(file, link);
    expect(isEntrypoint(pathToFileURL(file).href, link)).toBe(true);
  });

  it("is true for a path containing a space", () => {
    const p = join(spaced, "s.ts");
    expect(isEntrypoint(pathToFileURL(p).href, p)).toBe(true);
  });

  it("is false for a different file", () => {
    const other = join(spaced, "s.ts");
    expect(isEntrypoint(pathToFileURL(file).href, other)).toBe(false);
  });

  it("is false for a nonexistent path", () => {
    const p = join(root, "nope.ts");
    expect(isEntrypoint(pathToFileURL(p).href, p)).toBe(false);
  });

  it("is false when argv1 is undefined", () => {
    expect(isEntrypoint(pathToFileURL(file).href, undefined)).toBe(false);
  });
});
