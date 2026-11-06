import { permanentRedirect } from "next/navigation";

/** /api — the API documentation page was withdrawn. Kept as a redirect for inbound links. */
export default function ApiPage(): never {
  permanentRedirect("/data");
}
