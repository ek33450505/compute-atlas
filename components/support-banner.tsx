"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { isEmbedRoute } from "@/components/footer-gate";
import { SupportCta } from "@/components/support-cta";

const KEY_PREFIX = "ca-support-banner:";
export const DISMISSED_KEY = `${KEY_PREFIX}dismissed`;
export const PAGEVIEWS_KEY = `${KEY_PREFIX}pageviews`;
// Retired by D7 (2026-11-11): the cross-session visit counter. See removeLegacyKeys().
const LEGACY_VISITS_KEY = `${KEY_PREFIX}visits`;
const LEGACY_COUNTED_KEY = `${KEY_PREFIX}counted`;

/** D7 (2026-11-11): never on the first page view of a session; from the second on. */
const MIN_PAGE_VIEWS = 2;

/**
 * Routes where the banner never renders: admin, the immersive full-bleed map
 * (sized to exactly 100dvh, see footer-gate.tsx), every chrome-free embed, and
 * /support itself, where the page is the ask. Also the pages that already
 * carry an in-page support section (D7, 2026-11-11: one support mention per
 * page): /about, /contribute and every facility detail page.
 */
export function isBannerExcludedRoute(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/map" ||
    pathname === "/support" ||
    pathname === "/about" ||
    pathname === "/contribute" ||
    pathname.startsWith("/facilities/") ||
    isEmbedRoute(pathname)
  );
}

/** The session's page-view qualification: the second view onward. */
export function shouldShowOnPageViews(views: number): boolean {
  return views >= MIN_PAGE_VIEWS;
}

/**
 * Counts one page view in sessionStorage and returns the session total.
 * Returns 0 when sessionStorage is unavailable, so the banner stays hidden.
 */
function countPageView(): number {
  try {
    const stored = Number(window.sessionStorage.getItem(PAGEVIEWS_KEY));
    const next = (Number.isInteger(stored) && stored >= 0 ? stored : 0) + 1;
    window.sessionStorage.setItem(PAGEVIEWS_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

/** Dismissal lasts for the browser session only (sessionStorage). */
function readDismissedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissedThisSession(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage blocked: dismissal then lasts only for this page lifetime.
  }
}

/**
 * Earlier builds stored a 60-day dismissal in localStorage; drop it.
 * Safe to delete after 2027-01-31 (the 60-day key it clears had expired for
 * everyone by then; added 2026-10-27).
 * D7 (2026-11-11) also retired the localStorage visit counter and its
 * per-session "counted" flag; clear those too. Safe to delete after 2027-02-28.
 */
function removeLegacyKeys(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
    window.localStorage.removeItem(LEGACY_VISITS_KEY);
    window.sessionStorage.removeItem(LEGACY_COUNTED_KEY);
  } catch {
    // Ignore.
  }
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-primary hover:text-primary/80 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const DISMISS_CLASS =
  "-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-9 sm:w-9";

/**
 * Support card: a fixed bottom-right card from `sm` up, and an in-flow block
 * directly above the footer on phones so it never covers a primary action
 * (D7, 2026-11-11). Renders nothing on the server and on the first client
 * render (`visible` starts false), so crawlers never see it and hydration
 * matches; it appears only once the page-view effect decides the session has
 * reached its second page view (client-side navigations count) and the visitor
 * has not dismissed it this browser session.
 */
export function SupportBanner() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const barRef = useRef<HTMLElement>(null);

  // The last pathname counted, so a StrictMode double-run of the effect does
  // not count one page view twice.
  const countedPath = useRef<string | null>(null);

  useEffect(() => {
    removeLegacyKeys();
    if (countedPath.current === pathname) return;
    countedPath.current = pathname;
    // Every pathname change is a page view, excluded routes included. A full
    // reload remounts this and counts again: a reload of the first page is the
    // session's second view and shows the banner (D7 forbids only the first).
    const views = countPageView();
    setVisible(shouldShowOnPageViews(views) && !readDismissedThisSession());
  }, [pathname]);

  const excluded = isBannerExcludedRoute(pathname);
  const shown = visible && !excluded;

  // Reserve the bar's height (see globals.css) so it never covers the footer
  // or the last line of a page (WCAG 2.4.11).
  useEffect(() => {
    const el = barRef.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    // Reserve space only while the card is fixed (sm+); in flow on phones it
    // already occupies its own space. Crossing `sm` resizes the card, which
    // re-runs this through the observer.
    const apply = () => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed") {
        root.style.removeProperty("--support-bar-h");
        return;
      }
      const offset = parseFloat(style.bottom) || 0;
      root.style.setProperty("--support-bar-h", `${el.offsetHeight + offset}px`);
    };
    apply();
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(apply);
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--support-bar-h");
    };
  }, [shown]);

  const dismiss = useCallback(() => {
    writeDismissedThisSession();
    // Hiding the focused element would drop focus to <body>; hand it to <main>.
    if (barRef.current?.contains(document.activeElement)) {
      const main = document.getElementById("main-content");
      if (main) {
        if (!main.hasAttribute("tabindex")) main.tabIndex = -1;
        main.focus({ preventScroll: true });
      }
    }
    setVisible(false);
  }, []);

  if (!shown) return null;

  return (
    <section
      ref={barRef}
      aria-label="Support Compute Atlas"
      className="print:hidden relative z-30 mx-4 my-4 rounded-lg border border-border bg-background p-4 shadow-md motion-safe:animate-in motion-safe:fade-in motion-reduce:transition-none sm:fixed sm:inset-x-auto sm:bottom-4 sm:right-4 sm:m-0 sm:w-[22rem] sm:max-w-[calc(100vw-2rem)] sm:motion-safe:slide-in-from-right-4"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-display text-lg leading-snug text-foreground">
          Support the atlas
        </p>
        <button
          type="button"
          aria-label="Dismiss support message"
          onClick={dismiss}
          className={DISMISS_CLASS}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
        Independent, open source, no ads. Compute Atlas is reader-supported.
      </p>
      <div
        onClickCapture={dismiss}
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <SupportCta size="compact" />
        <Link href="/support" className={LINK_CLASS}>
          <span className="underline underline-offset-4">
            Why support? <span aria-hidden="true">→</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
