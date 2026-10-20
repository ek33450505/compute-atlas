import type { z } from "zod";
import type { communityStatusEnum, energySourceEnum, waterCoolingTypeEnum } from "@/lib/schema";
// Client-safe leaf (type-only imports). Each map is typed exhaustively against
// its Zod enum, so adding an enum member fails typecheck here instead of
// silently rendering a raw key in the facility page or the correction dialog.

export const ENERGY_SOURCE_LABELS: Readonly<Record<z.infer<typeof energySourceEnum>, string>> = {
  grid: "Grid",
  on_site_gas: "On-site gas",
  nuclear: "Nuclear",
  solar: "Solar",
  wind: "Wind",
  hydro: "Hydro",
  mixed: "Mixed",
  other: "Other",
};

export const COOLING_TYPE_LABELS: Readonly<Record<z.infer<typeof waterCoolingTypeEnum>, string>> = {
  evaporative: "Evaporative",
  air: "Air-cooled",
  closed_loop: "Closed-loop",
  hybrid: "Hybrid",
  unknown: "Unknown",
};

export const COMMUNITY_STATUS_LABELS: Readonly<Record<z.infer<typeof communityStatusEnum>, string>> = {
  supported: "Supported",
  mixed: "Mixed",
  contested: "Contested",
  opposed: "Opposed",
  litigation: "Litigation",
  unknown: "Unknown",
};
