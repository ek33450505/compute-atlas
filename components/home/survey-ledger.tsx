"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

// useLayoutEffect warns when it runs during SSR; swapping to useEffect on the
// server keeps the pre-paint reset a purely client-side hydration behavior.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface SurveyLedgerProps {
  count: number;
  states: number;
  operators: number;
  sources: number;
  operationalMw: number;
  underConstructionMw: number;
  plannedMw: number;
  className?: string;
}

const COUNT_UP_DURATION_MS = 1200;
const BAR_STAGGER_MS = 120;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : true
  );

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/** True once `ref`'s element has scrolled into view; fires once and disconnects. */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  // No IntersectionObserver in this environment (very old browser, or a test
  // sandbox that didn't stub one): treat as already in view instead of
  // syncing that fact from inside an effect.
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined"
  );

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  return inView;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Counts from 0 up to `target` once `start` flips true. Renders `target`
 * immediately under SSR / no-JS / reduced motion, and never resets to 0 in
 * that case.
 */
function useCountUp(
  target: number,
  start: boolean,
  reducedMotion: boolean,
  delay: number
): number {
  const [display, setDisplay] = useState(target);

  // Pre-paint: seed to 0 only when it WILL animate, so there is no flash of
  // the final value before it counts up. Also keeps the display snapped to
  // the final value for as long as reduced motion is active — a
  // useLayoutEffect (not useEffect) so the snap itself never flashes.
  useIsoLayoutEffect(() => {
    setDisplay(reducedMotion ? target : 0);
  }, [reducedMotion, target]);

  useEffect(() => {
    if (reducedMotion || !start) return;

    let rafId: number | undefined;
    const timeoutId = setTimeout(() => {
      const startTime = performance.now();
      const tick = (now: number) => {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / COUNT_UP_DURATION_MS);
        setDisplay(Math.round(easeOutCubic(t) * target));
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        }
      };
      rafId = requestAnimationFrame(tick);
    }, delay);

    return () => {
      clearTimeout(timeoutId);
      if (rafId !== undefined) cancelAnimationFrame(rafId);
    };
  }, [start, reducedMotion, target, delay]);

  return display;
}

/**
 * Grows a bar's width from 0 to `targetPct` once `start` flips true (a CSS
 * transition drives the actual "grow in" motion). Same SSR / no-flash /
 * reduced-motion contract as useCountUp.
 */
function useBarWidth(
  targetPct: number,
  start: boolean,
  reducedMotion: boolean,
  delay: number
): number {
  const [pct, setPct] = useState(targetPct);

  // Same pre-paint / no-flash / reduced-motion contract as useCountUp.
  useIsoLayoutEffect(() => {
    setPct(reducedMotion ? targetPct : 0);
  }, [reducedMotion, targetPct]);

  useEffect(() => {
    if (reducedMotion || !start) return;
    const timeoutId = setTimeout(() => setPct(targetPct), delay);
    return () => clearTimeout(timeoutId);
  }, [start, reducedMotion, targetPct, delay]);

  return pct;
}

interface LedgerTileProps {
  value: number;
  label: string;
  ariaLabel: string;
  format?: (value: number) => string;
}

function LedgerTile({ value, label, ariaLabel, format }: LedgerTileProps) {
  const display = format ? format(value) : Math.round(value).toString();
  return (
    <div
      className="flex flex-col items-center gap-1 text-center"
      aria-label={ariaLabel}
    >
      <span
        className="font-mono tabular-nums text-4xl font-semibold text-foreground"
        aria-hidden="true"
      >
        {display}
      </span>
      <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

interface PipelineBarProps {
  label: string;
  figure: string;
  ariaLabel: string;
  pct: number;
  color: string;
}

function PipelineBar({ label, figure, ariaLabel, pct, color }: PipelineBarProps) {
  return (
    <div aria-label={ariaLabel}>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          className="font-mono tabular-nums text-sm text-foreground"
          aria-hidden="true"
        >
          {figure}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.7 }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export function SurveyLedger({
  count,
  states,
  operators,
  sources,
  operationalMw,
  underConstructionMw,
  plannedMw,
  className,
}: SurveyLedgerProps) {
  const reducedMotion = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const inView = useInView(sectionRef);
  const start = inView || reducedMotion;

  const displayCount = useCountUp(count, start, reducedMotion, 0);
  const displayStates = useCountUp(states, start, reducedMotion, 0);
  const displayOperators = useCountUp(operators, start, reducedMotion, 0);
  const displaySources = useCountUp(sources, start, reducedMotion, 0);

  const displayOperationalMw = useCountUp(operationalMw, start, reducedMotion, 0);
  const displayUnderConstructionMw = useCountUp(
    underConstructionMw,
    start,
    reducedMotion,
    BAR_STAGGER_MS
  );
  const displayPlannedMw = useCountUp(
    plannedMw,
    start,
    reducedMotion,
    BAR_STAGGER_MS * 2
  );

  const operationalPct = useBarWidth(
    plannedMw > 0 ? (operationalMw / plannedMw) * 100 : 0,
    start,
    reducedMotion,
    0
  );
  const underConstructionPct = useBarWidth(
    plannedMw > 0 ? (underConstructionMw / plannedMw) * 100 : 0,
    start,
    reducedMotion,
    BAR_STAGGER_MS
  );
  const plannedPct = useBarWidth(100, start, reducedMotion, BAR_STAGGER_MS * 2);

  const operatingGW = (operationalMw / 1000).toFixed(1);
  const ucGW = (underConstructionMw / 1000).toFixed(0);
  const plannedGW = (plannedMw / 1000).toFixed(0);
  const ratio = operationalMw > 0 ? Math.round(plannedMw / operationalMw) : 0;

  const displayOperatingGW = (displayOperationalMw / 1000).toFixed(1);
  const displayUcGW = (displayUnderConstructionMw / 1000).toFixed(0);
  const displayPlannedGW = (displayPlannedMw / 1000).toFixed(0);

  const caption = `Among sites that disclose capacity, the announced pipeline (${plannedGW} GW) outweighs operating capacity (${operatingGW} GW) by roughly ${ratio}-to-1 — ${ucGW} GW is already under construction. Sums cover disclosed capacities only.`;

  return (
    <section aria-label="Dataset survey" className={className} ref={sectionRef}>
      <div className="flex flex-wrap gap-8">
        <LedgerTile
          value={displayCount}
          label="Sites tracked"
          ariaLabel={`${count} sites tracked`}
        />
        <LedgerTile
          value={displayStates}
          label="States covered"
          ariaLabel={`${states} states covered`}
        />
        <LedgerTile
          value={displayOperators}
          label="Operators"
          ariaLabel={`${operators} operators`}
        />
        <LedgerTile
          value={displaySources}
          label="Sources cited"
          ariaLabel={`${sources.toLocaleString("en-US")} sources cited`}
          format={(v) => Math.round(v).toLocaleString("en-US")}
        />
      </div>

      <div className="mt-10 space-y-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          § Power pipeline
        </p>

        <div className="space-y-3">
          <PipelineBar
            label="Operating"
            figure={`${displayOperatingGW} GW`}
            ariaLabel={`${operatingGW} GW operating`}
            pct={operationalPct}
            color="var(--status-operational)"
          />
          <PipelineBar
            label="Under construction"
            figure={`${displayUcGW} GW`}
            ariaLabel={`${ucGW} GW under construction`}
            pct={underConstructionPct}
            color="var(--status-under-construction)"
          />
          <PipelineBar
            label="Planned pipeline"
            figure={`${displayPlannedGW} GW`}
            ariaLabel={`${plannedGW} GW planned pipeline`}
            pct={plannedPct}
            color="var(--primary)"
          />
        </div>

        <p className="text-sm text-muted-foreground">{caption}</p>
      </div>
    </section>
  );
}
