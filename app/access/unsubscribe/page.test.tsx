import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import UnsubscribePage, { dynamic, metadata } from "./page";

const TOKEN = "A".repeat(43);

afterEach(() => {
  vi.unstubAllEnvs();
});

const renderPage = async (searchParams: Record<string, string | string[] | undefined>) =>
  render(await UnsubscribePage({ searchParams: Promise.resolve(searchParams) }));

describe("/access/unsubscribe interstitial", () => {
  it("is force-dynamic, noindex and sends no referrer", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("still renders the form when the flag is off (an opt-out ignores the kill switch)", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    await renderPage({ token: TOKEN });
    expect(screen.queryByText(/not open yet/i)).not.toBeInTheDocument();
    expect(document.querySelector("form")).toHaveAttribute("action", `/api/dataset/unsubscribe?token=${TOKEN}`);
  });

  it.each([
    ["missing", {}],
    ["empty", { token: "" }],
    ["short", { token: "abc" }],
    ["malformed", { token: "!".repeat(43) }],
    ["array", { token: [TOKEN, TOKEN] }],
  ])("shows the unsubscribe-specific invalid copy and no form for a %s token", async (_label, params) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage(params);
    expect(screen.getByText(/this unsubscribe link isn't valid/i)).toBeInTheDocument();
    expect(screen.queryByText(/confirmation links|renewal links/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact us/i })).toHaveAttribute("href", "/contact");
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders one native POST form with the token in the action URL and no auto-submit", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ token: TOKEN });
    const forms = document.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toHaveAttribute("method", "post");
    expect(forms[0]).toHaveAttribute("action", `/api/dataset/unsubscribe?token=${TOKEN}`);
    const button = screen.getByRole("button", { name: "Unsubscribe from edition notices" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).not.toHaveFocus();
    expect(document.querySelector("script, [autofocus], meta[http-equiv]")).toBeNull();
  });

  it("says the access link keeps working", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ token: TOKEN });
    expect(screen.getByText(/your access link keeps working/i)).toBeInTheDocument();
  });
});
