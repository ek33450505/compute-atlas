import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDatabaseUrl, readsUseDatabase } from "@/lib/db/client";

/**
 * `readsUseDatabase` reads three env vars directly (`DATABASE_URL`,
 * `VERCEL_ENV`, `PREVIEW_USE_DB`) rather than taking parameters, so each
 * case mutates `process.env` and restores the original values afterward
 * rather than mocking the module.
 */
describe("readsUseDatabase", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL_ENV;
    delete process.env.PREVIEW_USE_DB;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns false on a preview deployment with no escape hatch", () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.VERCEL_ENV = "preview";
    expect(readsUseDatabase()).toBe(false);
  });

  it("returns true on a preview deployment when PREVIEW_USE_DB=1", () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.VERCEL_ENV = "preview";
    process.env.PREVIEW_USE_DB = "1";
    expect(readsUseDatabase()).toBe(true);
  });

  it("returns false on preview even with PREVIEW_USE_DB set to a non-'1' value", () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.VERCEL_ENV = "preview";
    process.env.PREVIEW_USE_DB = "true";
    expect(readsUseDatabase()).toBe(false);
  });

  it("defers to hasDatabaseUrl() in production (DATABASE_URL set)", () => {
    process.env.DATABASE_URL = "postgres://example";
    process.env.VERCEL_ENV = "production";
    expect(readsUseDatabase()).toBe(true);
    expect(readsUseDatabase()).toBe(hasDatabaseUrl());
  });

  it("returns false with no DATABASE_URL regardless of VERCEL_ENV", () => {
    process.env.VERCEL_ENV = "production";
    expect(readsUseDatabase()).toBe(false);
  });

  it("defers to hasDatabaseUrl() when VERCEL_ENV is unset (local dev / CI)", () => {
    process.env.DATABASE_URL = "postgres://example";
    expect(readsUseDatabase()).toBe(true);
  });
});
