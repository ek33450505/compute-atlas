import { permanentRedirect } from "next/navigation";

/** Withdrawn with /access; kept as a redirect for inbound links. */
export default function Page(): never {
  permanentRedirect("/contact");
}
