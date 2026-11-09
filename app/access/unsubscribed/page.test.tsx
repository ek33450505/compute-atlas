import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import UnsubscribedPage, { metadata } from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/access/unsubscribed", () => {
  it("is noindex", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("says access is unaffected and points to /contact to resume, when enabled", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(<UnsubscribedPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Unsubscribed" })).toBeInTheDocument();
    expect(screen.getByText(/your access link is not affected and keeps working/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact page/i })).toHaveAttribute("href", "/contact");
  });

  it("still confirms the unsubscribe when the flag is off (an opt-out ignores the kill switch)", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    render(<UnsubscribedPage />);
    expect(screen.queryByText(/not open yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/weekly dataset edition notice/i)).toBeInTheDocument();
  });
});
