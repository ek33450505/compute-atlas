import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/crypto/page.test.tsx / app/gaps/page.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import ContributePage from "./page";

describe("ContributePage", () => {
  it("renders a pointer link to /gaps with an accessible name", () => {
    render(<ContributePage />);

    const gapsLink = screen.getByRole("link", {
      name: /see where the dataset needs help/i,
    });
    expect(gapsLink).toHaveAttribute("href", "/gaps");
  });

  it("keeps the existing 'Support the atlas' heading and link intact", () => {
    render(<ContributePage />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Support the atlas" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /more on how compute atlas is funded/i })
    ).toHaveAttribute("href", "/support");
  });
});

// ---------------------------------------------------------------------------
// C1b, Unit C — this page reads SUBMISSION_NOTIFY_ENABLED once at render time
// (via lib/submission-notify.ts's submissionNotifyEnabled(), read-at-call-time
// by design) and passes it down to ContributeFacilityForm as a plain prop.
// Exercised end-to-end here via the real env var rather than a mock, since
// that is exactly the seam page.tsx is documented to use.
// ---------------------------------------------------------------------------

describe("ContributePage — notify email flag", () => {
  const ORIGINAL_ENV = process.env.SUBMISSION_NOTIFY_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SUBMISSION_NOTIFY_ENABLED;
    else process.env.SUBMISSION_NOTIFY_ENABLED = ORIGINAL_ENV;
  });

  it("does not render the notify-email field when the env flag is unset (default)", () => {
    delete process.env.SUBMISSION_NOTIFY_ENABLED;
    render(<ContributePage />);
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
  });

  it("passes the flag through to the facility form when SUBMISSION_NOTIFY_ENABLED=true", () => {
    process.env.SUBMISSION_NOTIFY_ENABLED = "true";
    render(<ContributePage />);
    expect(screen.getByLabelText(/your email/i)).toBeInTheDocument();
  });
});
