export const siteConfig = {
  name: "Compute Atlas",
  tagline: "Mapping the U.S. compute buildout",
  description:
    "Compute Atlas is an open, source-cited map of the U.S. compute buildout — traditional and hyperscale data centers, AI-specific facilities, crypto-mining operations, and the dedicated power generation built to supply them — from proposed and permitted to under construction and operational, with a public source behind every record.",
  url: "https://www.compute-atlas.com",
  repoUrl: "https://github.com/ek33450505/compute-atlas",
  /**
   * Two funding paths, both live. Named individually rather than as one
   * `sponsorUrl` so a new destination can never silently repoint an existing
   * link. Ko-fi leads: guest checkout, no account needed — GitHub Sponsors
   * requires a GitHub account, which is the exact barrier for this site's
   * actual audience (residents, local journalists, county officials). GitHub
   * Sponsors stays because it is 0%-fee on one-off gifts.
   */
  kofiUrl: "https://ko-fi.com/L2T725R7FV",
  githubSponsorsUrl: "https://github.com/sponsors/ek33450505",
} as const;
