import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import AccessPage, { metadata } from "./page";
import ConfirmedPage, { metadata as confirmedMeta } from "./confirmed/page";
import InvalidPage, { metadata as invalidMeta } from "./invalid/page";
import RenewedPage, { metadata as renewedMeta } from "./renewed/page";
import ConfirmPage, { dynamic as confirmDynamic, metadata as confirmMeta } from "./confirm/page";
import RenewPage, { dynamic as renewDynamic, metadata as renewMeta } from "./renew/page";

const TOKEN = "A".repeat(43);
const NOINDEX = { index: false, follow: false };


afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/access", () => {
  it("renders the request page when sharing is enabled", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(<AccessPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Dataset access" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /how it works/i })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/access terms \(draft\)/i)).toBeInTheDocument();
    expect(screen.getByText(/privacy notice \(draft\)/i)).toBeInTheDocument();
    expect(screen.getAllByText(/terms version 2026-11-draft/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "How to cite" })).toHaveAttribute("href", "/data");
    expect(screen.getByRole("button", { name: /request access/i })).toBeInTheDocument();
  });

  it.each([["false"], [undefined]])("shows the not-open copy, no form and no terms, when the flag is %s", (value) => {
    if (value === undefined) vi.stubEnv("DATASET_SHARING_ENABLED", "");
    else vi.stubEnv("DATASET_SHARING_ENABLED", value);
    render(<AccessPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Dataset access" })).toBeInTheDocument();
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact page/i })).toHaveAttribute("href", "/contact");
    expect(screen.queryByRole("button", { name: /request access/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/terms version/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/bulk|paus/i)).not.toBeInTheDocument();
  });

  it("is indexable with /access as canonical", () => {
    expect(metadata.alternates?.canonical).toBe("/access");
    expect(metadata.title).toBe("Dataset access");
    expect(metadata.robots).toBeUndefined();
  });
});

describe("result pages", () => {
  it.each([
    ["confirmed", ConfirmedPage, confirmedMeta, /your address is confirmed and the request is in the review queue/i],
    ["renewed", RenewedPage, renewedMeta, /renewal requested\. it is reviewed by hand/i],
    ["invalid", InvalidPage, invalidMeta, /this link is no longer valid/i],
  ])("%s renders its copy when enabled, not-open when disabled, and is noindex", (_n, Page, meta, copy) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    const { unmount } = render(<Page />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(meta.robots).toEqual(NOINDEX);
    unmount();

    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    render(<Page />);
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.queryByText(copy)).not.toBeInTheDocument();
  });

  it("invalid links to a new request", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(<InvalidPage />);
    expect(screen.getByRole("link", { name: "Submit a new request" })).toHaveAttribute("href", "/access");
  });
});

describe.each([
  ["confirm", ConfirmPage, confirmMeta, confirmDynamic, "/api/access/confirm", "Confirm this request"],
  ["renew", RenewPage, renewMeta, renewDynamic, "/api/access/renew", "Request renewal"],
])("%s interstitial", (_n, Page, meta, dynamic, action, button) => {
  const renderPage = async (searchParams: Record<string, string | string[] | undefined>) =>
    render(await Page({ searchParams: Promise.resolve(searchParams) }));

  it("is force-dynamic and noindex", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(meta.robots).toEqual(NOINDEX);
  });

  it("shows not-open and no form when the flag is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "false");
    await renderPage({ token: TOKEN });
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
  });

  it.each([
    ["missing", {}],
    ["empty", { token: "" }],
    ["short", { token: "abc" }],
    ["malformed", { token: "!".repeat(43) }],
    ["array", { token: [TOKEN, TOKEN] }],
  ])("shows the invalid copy and no form for a %s token", async (_label, params) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage(params);
    expect(screen.getByText(/this link is no longer valid/i)).toBeInTheDocument();
    expect(document.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders one POST form with a hidden token and a submit button for a valid token", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ token: TOKEN });
    const forms = document.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(forms[0]).toHaveAttribute("method", "post");
    expect(forms[0]).toHaveAttribute("action", action);
    const hidden = forms[0].querySelector<HTMLInputElement>('input[type="hidden"][name="token"]');
    expect(hidden?.value).toBe(TOKEN);
    const submitBtn = screen.getByRole("button", { name: button });
    expect(submitBtn).toHaveAttribute("type", "submit");
    expect(submitBtn).not.toHaveFocus();
    expect(document.querySelector("script, [autofocus]")).toBeNull();
  });
});
