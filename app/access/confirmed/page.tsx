import type { Metadata } from "next";

import { AccessConfirmedContent } from "@/components/access/access-confirmed-content";

// Transactional page reached only via an emailed confirm link — never a
// useful search result, even if the link leaks. Also carries the token in a
// URL fragment, which a crawler would never see anyway (fragments aren't
// sent to the server), but noindex is the same discipline the /subscribe/*
// transactional pages already use.
export const metadata: Metadata = {
  title: "Access token confirmed",
  robots: { index: false, follow: false },
};

export default function AccessConfirmedPage() {
  return <AccessConfirmedContent />;
}
