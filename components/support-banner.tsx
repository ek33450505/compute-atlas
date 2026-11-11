"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { isEmbedRoute } from "@/components/footer-gate";
import { SupportCta } from "@/components/support-cta";

const KEY_PREFIX = "ca-support-banner:";
export const VISITS_KEY = `${KEY_PREFIX}visits`;
export const DISMISSED_KEY = `${KEY_PREFIX}dismissed`;
const COUNTED_KEY = `${KEY_PREFIX}counted`;

const MIN_VISITS = 2;

/**
 * Routes where the banner never renders: admin, the immersive full-bleed map
 * (sized to exactly 100dvh, see footer-gate.tsx), every chrome-free embed, and
 * /support itself, where the page is the ask.
 */
export function isBannerExcludedRoute(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/map" ||
    pathname === "/support" ||
    isEmbedRoute(pathname)
  );
}

/** The returning-visitor path: shown from the second visit, unless dismissed. */
export function shouldShowOnVisits(visits: number): boolean {
  return visits >= MIN_VISITS;
}

function readRaw(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

/** Stored visit count; anything but a non-negative integer reads as 0. */
function readVisits(): number {
  const n = readRaw(VISITS_KEY);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : 0;
}

function writeVisits(value: number): void {
  try {
    window.localStorage.setItem(VISITS_KEY, String(value));
  } catch {
    // Storage blocked or full: the count simply does not advance.
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
 */
function removeLegacyDismissal(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Ignore.
  }
}

/** Counts this browser session's visit once; returns the current total. */
function countVisit(): number {
  let alreadyCounted = false;
  try {
    alreadyCounted = window.sessionStorage.getItem(COUNTED_KEY) === "1";
  } catch {
    // No sessionStorage: cannot guard against double counting, so do not count.
    return readVisits();
  }
  const stored = readVisits();
  if (alreadyCounted) return stored;
  const next = stored + 1;
  writeVisits(next);
  try {
    window.sessionStorage.setItem(COUNTED_KEY, "1");
  } catch {
    // Ignore: worst case the next mount in this session counts again.
  }
  return next;
}

const LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-primary hover:text-primary/80 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const DISMISS_CLASS =
  "-mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:h-9 sm:w-9";

/**
 * Floating, non-modal support card (bottom sheet on phones). Renders nothing
 * on the server and on the first client render (`visible` starts false), so
 * crawlers never see it and hydration matches; it appears only once the mount
 * effect decides the visitor qualifies (second visit, or a first visit that
 * scrolled a viewport) and has not dismissed it this browser session.
 */
export function SupportBanner() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    removeLegacyDismissal();
    if (readDismissedThisSession()) return;

    const show = () => setVisible(true);

    if (shouldShowOnVisits(countVisit())) {
      show();
      return;
    }

    const onScroll = () => {
      if (window.scrollY >= window.innerHeight) {
        window.removeEventListener("scroll", onScroll);
        show();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const excluded = isBannerExcludedRoute(pathname);
  const shown = visible && !excluded;

  // Reserve the bar's height (see globals.css) so it never covers the footer
  // or the last line of a page (WCAG 2.4.11).
  useEffect(() => {
    const el = barRef.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    // Height plus the card's bottom offset (16px on sm+, 0 for the phone sheet).
    const apply = () => {
      const offset = parseFloat(getComputedStyle(el).bottom) || 0;
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
      className="print:hidden fixed inset-x-0 bottom-0 z-30 rounded-t-lg border border-border bg-background px-4 pb-4 pt-4 shadow-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-reduce:transition-none sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-lg sm:motion-safe:slide-in-from-bottom-0 sm:motion-safe:slide-in-from-right-4"
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
