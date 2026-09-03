"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageMasthead } from "@/components/page-masthead";
import { Button, buttonVariants } from "@/components/ui/button";
import { StatePanel } from "@/components/feedback/state-panel";

// ---------------------------------------------------------------------------
// Hash-token store — reads the access token from the URL fragment
// (`#token=...`), never from a query param or the server. See
// app/api/access/confirm/route.ts's comment for why: fragments never reach a
// `Referer` header or get logged server-side. This means the token literally
// never touches this page's server render; it only exists in the browser
// after hydration.
//
// Implemented as useSyncExternalStore (mirrors MapFilterSubheader's
// viewport-query pattern, components/map/map-filter-subheader.tsx) rather
// than useEffect+setState — reading external browser state (here,
// location.hash) via setState-in-an-effect trips the react-compiler
// set-state-in-effect lint rule and causes an extra cascading render;
// useSyncExternalStore is the React-native primitive for exactly this shape.
// The hash is set once (via the server redirect) and never changes for the
// life of this page, so `subscribe` is a no-op unsubscribe.
// ---------------------------------------------------------------------------

function subscribeHash(): () => void {
  return () => {};
}

function getHashToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  return token && token.length > 0 ? token : null;
}

/** Server (and first client render) has no `window` — report null so server/client agree, avoiding a hydration mismatch. */
function getHashTokenServerSnapshot(): string | null {
  return null;
}

async function copyToken(token: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    toast.error("Couldn't copy the token");
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    toast.success("Token copied to clipboard");
  } catch {
    toast.error("Couldn't copy the token");
  }
}

/**
 * Client-only body of /access/confirmed. Split out from page.tsx so the page
 * itself can stay a server component (metadata + robots noindex) while this
 * piece reads the fragment, mirroring the split most pages-with-client-
 * interactivity in this repo use rather than making the whole route
 * "use client".
 */
export function AccessConfirmedContent() {
  const token = useSyncExternalStore(subscribeHash, getHashToken, getHashTokenServerSnapshot);

  if (!token) {
    return (
      <StatePanel
        titleAs="h1"
        eyebrow="No token found"
        title="No token found"
        description="This page only shows a token right after confirming a bulk API access request. If you reached this page another way, request a new link."
        actions={
          <Link href="/access" className={buttonVariants({ variant: "outline" })}>
            Request access
          </Link>
        }
      />
    );
  }

  const curlExample = `curl -H "Authorization: Bearer ${token}" \\\n  "https://www.compute-atlas.com/api/facilities"`;

  return (
    <div
      data-content-width="2xl"
      className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16 space-y-10"
    >
      <Breadcrumb items={[{ label: "Bulk API access", href: "/access" }, { label: "Confirmed" }]} />

      <PageMasthead
        eyebrow="CONFIRMED"
        title="Your access token"
        dek="This is the only time this token is shown. Copy it somewhere safe now."
      />

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Your token</p>
        <div className="overflow-x-auto rounded-md border border-border bg-muted/50">
          <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-foreground">
            <code>{token}</code>
          </pre>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Copy access token to clipboard"
          onClick={() => copyToken(token)}
        >
          Copy token
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Ready-to-use example</p>
        <div className="overflow-x-auto rounded-md border border-border bg-muted/50">
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
            <code>{curlExample}</code>
          </pre>
        </div>
      </div>

      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        We don&rsquo;t store this token anywhere you can retrieve it again &mdash; if you lose
        it, request a new one at{" "}
        <Link
          href="/access"
          className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          /access
        </Link>
        .
      </p>
    </div>
  );
}
