// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATASET_TERMS_VERSION } from "@/lib/dataset-grants";
import AccessTermsPage, { generateMetadata } from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/access/terms", () => {
  it("renders all three sections and the version when sharing is on", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(<AccessTermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Dataset access terms" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Access terms" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dataset subscriptions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privacy notice" })).toBeInTheDocument();
    expect(screen.getByText(`Terms version ${DATASET_TERMS_VERSION}.`)).toBeInTheDocument();
    expect(screen.getByText(/plus applicable tax/)).toBeInTheDocument();
    expect(screen.getByText(/PayPal holds payment details/)).toBeInTheDocument();
  });

  it("shows the not-open page, noindexed, when sharing is off", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(<AccessTermsPage />);
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Dataset subscriptions" })).not.toBeInTheDocument();
    expect(generateMetadata().robots).toEqual({ index: false, follow: false });
  });

  it("is indexable when sharing is on", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    expect(generateMetadata().robots).toBeUndefined();
  });
});
