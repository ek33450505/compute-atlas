import { permanentRedirect } from "next/navigation";

/**
 * /access — the bulk API access request page was withdrawn. Kept as a redirect
 * for inbound links and for the /access/* pages that still link here.
 */
export default function AccessPage(): never {
  permanentRedirect("/contact");
}
