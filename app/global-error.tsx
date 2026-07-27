"use client";

import { useEffect } from "react";
import "./globals.css";
import { StatePanel } from "@/components/feedback/state-panel";
import { Button } from "@/components/ui/button";

// Last-resort boundary — replaces the root layout entirely, so it renders
// its own <html>/<body>. The layout's fonts/providers are not present here;
// tokens still resolve from globals.css and fonts gracefully fall back.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <StatePanel
          titleAs="h1"
          eyebrow="Error"
          title="Something went wrong"
          description="The atlas hit an unexpected error. This is usually fleeting — try again in a moment."
          actions={<Button onClick={() => reset()}>Try again</Button>}
        />
      </body>
    </html>
  );
}
