import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/contact/contact-form", () => ({ ContactForm: () => null }));

import ContactPage from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/contact request-access line", () => {
  it("links to /access?from=data when dataset sharing is enabled", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(<ContactPage />);
    expect(screen.getByText(/need the full dataset for reporting or research\?/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "/access?from=data");
  });

  it.each([["false"], [""]])("renders no request-access text when the flag is %j", (value) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", value);
    render(<ContactPage />);
    expect(screen.queryByText(/request access/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/full dataset/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Get in touch" })).toBeInTheDocument();
  });
});
