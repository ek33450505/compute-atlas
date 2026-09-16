import "@testing-library/jest-dom/vitest";

// jsdom does not implement window.matchMedia — mock it for any component that
// queries a media feature, `prefers-reduced-motion` above all (this site has no
// dark mode, so nothing reads prefers-color-scheme).
// Guarded: this setup file runs for every test file regardless of a per-file
// `@vitest-environment node` docblock (e.g. the DB integration tests), where
// `window` is undefined.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
