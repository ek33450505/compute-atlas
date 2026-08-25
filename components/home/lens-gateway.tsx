import Link from "next/link";
import {
  BarChart3,
  Bitcoin,
  Building2,
  Cpu,
  Globe,
  Megaphone,
  MapPin,
  Zap,
  type LucideIcon,
} from "lucide-react";

export interface LensGatewayProps {
  counts: {
    sites: number;
    states: number;
    utilityLinked: number;
    frictionCount: number;
    aiClassified: number;
    operators: number;
    plannedGw: number;
    cryptoCount: number;
  };
  className?: string;
}

interface Lens {
  label: string;
  href: string;
  icon: LucideIcon;
  stat: (counts: LensGatewayProps["counts"]) => string;
  blurb: string;
  lead?: boolean;
}

const LENSES: Lens[] = [
  {
    label: "Map",
    href: "/map",
    icon: Globe,
    stat: (c) => `${c.sites.toLocaleString("en-US")} sites`,
    blurb: "Every tracked site plotted on the interactive globe.",
    lead: true,
  },
  {
    label: "By state",
    href: "/states",
    icon: MapPin,
    stat: (c) => `${c.states} states`,
    blurb: "Every state, ranked by capacity, build status, and friction.",
  },
  {
    label: "Power & energy",
    href: "/power",
    icon: Zap,
    stat: (c) => `${c.utilityLinked} grid-linked`,
    blurb: "Utilities, fuel mix, and the generation feeding the buildout.",
  },
  {
    label: "Opposition",
    href: "/opposition",
    icon: Megaphone,
    stat: (c) => `${c.frictionCount} in friction`,
    blurb: "Sites facing documented community friction, each with sources.",
  },
  {
    label: "AI data centers",
    href: "/ai",
    icon: Cpu,
    stat: (c) => `${c.aiClassified} classified`,
    blurb: "Data centers by AI-classification density per state.",
  },
  {
    label: "Operators",
    href: "/operators",
    icon: Building2,
    stat: (c) => `${c.operators} operators`,
    blurb: "Every company running tracked capacity, ranked by build-out.",
  },
  {
    label: "Rankings",
    href: "/rankings",
    icon: BarChart3,
    stat: (c) => `${c.plannedGw} GW ranked`,
    blurb: "The biggest projects, operators, and states by megawatt.",
  },
  {
    label: "Crypto mining",
    href: "/crypto",
    icon: Bitcoin,
    stat: (c) => `${c.cryptoCount} sites`,
    blurb: "Bitcoin and altcoin sites, tracked apart from the AI buildout.",
  },
];

export function LensGateway({ counts, className }: LensGatewayProps) {
  return (
    <section aria-labelledby="ways-in-heading" className={className}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § Explore the atlas
      </p>
      <h2
        id="ways-in-heading"
        className="mt-1 font-display text-2xl text-foreground"
      >
        Find your way in
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {LENSES.length} lenses on the same source-cited dataset.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LENSES.map(({ label, href, icon: Icon, stat, blurb, lead }) => (
          <li key={href}>
            <Link
              href={href}
              className={`group flex h-full min-h-11 flex-col gap-2 rounded-sm border border-border p-4 transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2${
                lead ? " border-primary/40 bg-primary/5 hover:bg-primary/10" : ""
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <Icon aria-hidden="true" className="size-5 text-primary" />
                <span className="font-mono text-xs text-muted-foreground">
                  {stat(counts)}
                </span>
              </span>
              <span className="font-display text-lg text-foreground transition-colors motion-reduce:transition-none group-hover:text-primary">
                {label}
              </span>
              <span className="text-sm leading-relaxed text-muted-foreground">
                {blurb}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
        <Link
          href="/explore"
          className="inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          See every lens →
        </Link>
        <Link
          href="/stats"
          className="inline-flex min-h-11 items-center rounded-sm font-mono text-xs uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          View full statistics →
        </Link>
      </div>
    </section>
  );
}
