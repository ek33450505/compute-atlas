import type { MetadataRoute } from "next";
import { getAllFacilities } from "@/lib/data";
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
  ];
}

/**
 * Builds facility route entries for the sitemap.
 * Exported separately so it can be unit-tested without Next.js.
 */
export function buildFacilityRoutes(): MetadataRoute.Sitemap {
  return getAllFacilities().map((f) => ({
    url: `${siteConfig.url}/facilities/${f.id}`,
    lastModified: new Date(f.lastUpdated),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [...buildStaticRoutes(), ...buildFacilityRoutes()];
}
