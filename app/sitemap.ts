import type { MetadataRoute } from "next";
import { getAllFacilities, getStates, getOperators, operatorSlug } from "@/lib/data";
import { stateSlugFromCode } from "@/lib/us-states";
import { siteConfig } from "@/lib/site";

/**
 * Builds the list of static route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export function buildStaticRoutes(): MetadataRoute.Sitemap {
  return [
    {
      url: siteConfig.url,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${siteConfig.url}/map`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteConfig.url}/table`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${siteConfig.url}/states`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/operators`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/power`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/opposition`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${siteConfig.url}/stats`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${siteConfig.url}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${siteConfig.url}/api`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${siteConfig.url}/explore`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
  ];
}

/**
 * Builds facility route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildFacilityRoutes(): Promise<MetadataRoute.Sitemap> {
  const facilities = await getAllFacilities();
  return facilities.map((f) => ({
    url: `${siteConfig.url}/facilities/${f.id}`,
    lastModified: new Date(f.lastUpdated),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));
}

/**
 * Builds per-state route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildStateRoutes(): Promise<MetadataRoute.Sitemap> {
  const codes = await getStates();
  return codes.map((code) => ({
    url: `${siteConfig.url}/states/${stateSlugFromCode(code)}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));
}

/**
 * Builds per-operator route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export async function buildOperatorRoutes(): Promise<MetadataRoute.Sitemap> {
  const names = await getOperators();
  return names.map((name) => ({
    url: `${siteConfig.url}/operators/${operatorSlug(name)}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [stateRoutes, operatorRoutes, facilityRoutes] = await Promise.all([
    buildStateRoutes(),
    buildOperatorRoutes(),
    buildFacilityRoutes(),
  ]);
  return [
    ...buildStaticRoutes(),
    ...stateRoutes,
    ...operatorRoutes,
    ...facilityRoutes,
  ];
}
