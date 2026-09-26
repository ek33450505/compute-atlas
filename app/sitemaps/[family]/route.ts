import { buildUrlsetXml } from "@/lib/sitemap-xml";
import { SITEMAP_FAMILIES, SITEMAP_FAMILY_IDS } from "@/lib/sitemap-families";

export const revalidate = 3600;
// Unrecognised family => 404 rather than an empty-but-200 <urlset> — verified
// against Next 16.3.3.
export const dynamicParams = false;

// generateStaticParams puts the trailing ".xml" onto the id itself
// (`${id}.xml`), so the `family` param this route receives at runtime always
// arrives WITH that suffix. GET() strips it back off before looking the id
// up in SITEMAP_FAMILIES. Pairing this with `dynamicParams = false` above is
// what makes an unrecognised family a build-time-known 404 instead of a
// dynamically-rendered empty urlset.
export function generateStaticParams(): { family: string }[] {
  return SITEMAP_FAMILY_IDS.map((id) => ({ family: `${id}.xml` }));
}

// Same two headers as app/sitemap.xml/route.ts — see that file's comment for
// why (mirrors Next's own metadata-route cache headers; must stay
// header-neutral with the endpoint this replaces).
const SITEMAP_HEADERS = {
  "Content-Type": "application/xml",
  "Cache-Control": "public, max-age=0, must-revalidate",
} as const;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ family: string }> }
): Promise<Response> {
  const { family: rawFamily } = await ctx.params;
  const id = rawFamily.replace(/\.xml$/, "");
  const family = SITEMAP_FAMILIES.find((f) => f.id === id);

  if (family === undefined) {
    return new Response("Not Found", { status: 404 });
  }

  const entries = await family.build();
  return new Response(buildUrlsetXml(entries), { headers: SITEMAP_HEADERS });
}
