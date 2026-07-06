import "@testing-library/jest-dom/vitest";

// jsdom does not implement window.matchMedia — mock it for next-themes and any
// component that queries prefers-color-scheme or similar media features.
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
