import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Trailing slash matters: "/api/" blocks the JSON endpoints under
      // /api/... (facilities, stats, search, contribute, submissions) but
      // NOT the public doc page at the bare "/api" path (app/api/page.tsx),
      // which stays crawlable and is listed in the sitemap.
      disallow: ["/admin/", "/api/"],
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
