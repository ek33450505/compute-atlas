import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // Pre-launch: the site is deployed to a public Vercel URL while the repo is
  // still private and the custom domain is unwired. Keep this work-in-progress
  // out of search indexes until go-live. AT LAUNCH, flip this back to:
  //   import { siteConfig } from "@/lib/site";
  //   rules: { userAgent: "*", allow: "/" },
  //   sitemap: `${siteConfig.url}/sitemap.xml`,
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
