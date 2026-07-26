"use client";

import { useEffect } from "react";
import Link from "next/link";
import { StatePanel } from "@/components/feedback/state-panel";
import { Button, buttonVariants } from "@/components/ui/button";

export default function Error({
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
    <StatePanel
      titleAs="h1"
      eyebrow="Error"
      title="The atlas couldn't load this"
      description="Some of this data is temporarily unavailable. This is usually fleeting — try again in a moment."
      actions={
        <>
          <Button onClick={() => reset()}>Try again</Button>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Back to the map
          </Link>
        </>
      }
    />
  );
}
