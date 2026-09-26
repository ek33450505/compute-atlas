import type { MetadataRoute } from "next";
import {
  buildStaticRoutes,
  buildFacilityRoutes,
  buildStateRoutes,
  buildOperatorRoutes,
  buildStakeholderRoutes,
  buildStatusRoutes,
  buildMetroRoutes,
  buildCountyRoutes,
  buildLearnRoutes,
} from "@/lib/sitemap-routes";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [
    staticRoutes,
    learnRoutes,
    stateRoutes,
    operatorRoutes,
    stakeholderRoutes,
    facilityRoutes,
    statusRoutes,
    metroRoutes,
    countyRoutes,
  ] = await Promise.all([
    buildStaticRoutes(),
    buildLearnRoutes(),
    buildStateRoutes(),
    buildOperatorRoutes(),
    buildStakeholderRoutes(),
    buildFacilityRoutes(),
    buildStatusRoutes(),
    buildMetroRoutes(),
    buildCountyRoutes(),
  ]);
  return [
    ...staticRoutes,
    ...learnRoutes,
    ...stateRoutes,
    ...operatorRoutes,
    ...stakeholderRoutes,
    ...facilityRoutes,
    ...statusRoutes,
    ...metroRoutes,
    ...countyRoutes,
  ];
}
