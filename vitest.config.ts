import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**", "**/.next/**"],
    // Vitest's 5000ms default is too tight for a 175-file suite running in
    // parallel. The FacilityForm create-mode tests do legitimate multi-step
    // async work (type 7 fields, submit, await assertions) — 305-750ms when
    // run solo — but under full-suite scheduling the same work has been
    // measured at 5.6-5.9s and failed with a bare "Test timed out in 5000ms"
    // and no assertion error. That is ~10x headroom being eaten by worker
    // contention, not a hang: the identical tests pass 16/16 in isolation.
    //
    // Passing `{ delay: null }` to userEvent.setup() (see
    // app/admin/facilities/facility-form.test.tsx) removed the per-keystroke
    // real `setTimeout` and cut solo runtime 25-45%, but reducing the work
    // does not create headroom — it only moves the odds, and the failure
    // recurred. This raises the ceiling instead.
    //
    // A timeout exists to catch genuine hangs, and 20s still does that; it
    // costs nothing on a passing run, since the value is only consulted when
    // exceeded. Do NOT raise this further to silence a NEW slow test —
    // a test that needs more than 20s is telling you something real.
    testTimeout: 20_000,
    // Same reasoning for hooks, different work. The PGlite integration suites
    // (`makeTestDb()` in beforeAll — lib/*.integration.test.ts, scripts/seed.test.ts)
    // spin up an in-process Postgres, and 8 of them failed `Hook timed out in
    // 10000ms` under heavy load. Honest caveat on that measurement: the load was
    // partly artificial (four back-to-back full-suite runs alongside a local
    // Ollama sweep), and these same files pass in a normal single run. The
    // justification is not that observation but the standing one — a CI runner is
    // slow and variable, and 10s to stand up a Postgres is thin margin. Raising it
    // costs nothing on a passing run.
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
