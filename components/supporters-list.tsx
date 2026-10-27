import type { Supporter } from "@/lib/supporters";

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

function SupporterItem({ supporter }: { supporter: Supporter }) {
  if (!supporter.url?.startsWith("https://")) return <li>{supporter.name}</li>;
  return (
    <li>
      <a
        href={supporter.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`${supporter.name} (opens in new tab)`}
        className={LINK_CLASS}
      >
        {supporter.name} <span aria-hidden="true">↗</span>
      </a>
    </li>
  );
}

function SupporterGroup({
  heading,
  supporters,
}: {
  heading: string;
  supporters: readonly Supporter[];
}) {
  if (supporters.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{heading}</h3>
      <ul className="max-w-2xl list-disc list-inside space-y-1 text-sm text-muted-foreground">
        {supporters.map((s) => (
          <SupporterItem key={`${s.kind}:${s.name}`} supporter={s} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Opt-in supporters on /support. Renders nothing while the list is empty, so
 * the page never shows an empty "Supporters" heading.
 */
export function SupportersList({ supporters }: { supporters: readonly Supporter[] }) {
  if (supporters.length === 0) return null;
  return (
    <section aria-labelledby="supporters-heading" className="space-y-4 border-t border-border pt-10">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § Supporters
      </p>
      <h2 id="supporters-heading" className="font-display text-2xl text-foreground">
        Supporters
      </h2>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        People and organizations who support the atlas and asked to be named.
        Support never changes what the record says.
      </p>
      <SupporterGroup
        heading="Institutions"
        supporters={supporters.filter((s) => s.kind === "institution")}
      />
      <SupporterGroup
        heading="Individuals"
        supporters={supporters.filter((s) => s.kind === "individual")}
      />
    </section>
  );
}
