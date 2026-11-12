import { NO_STORE_HEADERS } from "@/lib/api-response";
import { stateSlugFromCode } from "@/lib/us-states";

/**
 * Target of the home page's no-JS state picker (`GET /states/go?state=TX`).
 * Redirects a valid jurisdiction code to its hub and anything else (missing,
 * repeated, malformed, unknown) to the /states index. The Location is built
 * only from a slug that came out of our own table, never from the input, so
 * there is no open redirect; it is relative so it cannot pick up a wrong host.
 * No-store: a GET under a path Cloudflare's cache rule covers.
 *
 * The raw value must be exactly two ASCII letters BEFORE lookup, because
 * `toUpperCase()` folds non-ASCII (`ın` -> `IN`, Kelvin sign -> `K`).
 * HEAD is exported explicitly and answers like GET (303, same headers).
 *
 * No data read here: the picker only offers jurisdictions that have records,
 * so a valid code whose hub 404s is reachable only through a hand-typed URL.
 */
export function GET(request: Request): Response {
  const values = new URL(request.url).searchParams.getAll("state");
  const code = values.length === 1 ? values[0] : "";
  const slug = /^[A-Za-z]{2}$/.test(code) ? stateSlugFromCode(code) : undefined;
  return new Response(null, {
    status: 303,
    headers: {
      Location: slug ? `/states/${slug}` : "/states",
      ...NO_STORE_HEADERS,
    },
  });
}

export const HEAD = GET;
