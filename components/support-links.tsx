import { cn } from "@/lib/utils";
import { siteConfig } from "@/lib/site";

const BASE_CLASS =
  "inline-flex min-h-11 items-center gap-2 rounded-md border px-4 font-mono text-sm font-semibold tracking-wide transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const MONTHLY_CLASS = "border-primary bg-primary text-primary-foreground hover:bg-primary/90";
const ONE_OFF_CLASS = "border-border bg-background text-foreground hover:bg-muted";

interface SupportLinksProps {
  links?: typeof siteConfig.supportLinks;
}

function StripeLink({ href, label, className }: { href: string; label: string; className: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens Stripe checkout in new tab)`}
      className={cn(BASE_CLASS, className)}
    >
      {label} <span aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * The Stripe Payment Links configured for this deployment
 * (`siteConfig.supportLinks`): up to three fixed monthly amounts and one
 * pay-what-you-want one-off. Renders nothing when none are configured, so
 * there are never empty headings or broken buttons.
 */
export function SupportLinks({ links = siteConfig.supportLinks }: SupportLinksProps) {
  const monthly = [
    { href: links.monthly5, label: "$5 a month" },
    { href: links.monthly15, label: "$15 a month" },
    { href: links.monthly50, label: "$50 a month" },
  ].filter((m): m is { href: string; label: string } => m.href !== null);
  if (monthly.length === 0 && !links.oneOff) return null;

  return (
    <div className="space-y-4">
      {monthly.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Monthly</h3>
          <ul className="flex flex-wrap gap-3">
            {monthly.map((m) => (
              <li key={m.label}>
                <StripeLink href={m.href} label={m.label} className={MONTHLY_CLASS} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {links.oneOff && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">One-off</h3>
          <StripeLink href={links.oneOff} label="A one-off tip, any amount" className={ONE_OFF_CLASS} />
        </div>
      )}
    </div>
  );
}
