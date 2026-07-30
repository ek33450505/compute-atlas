import Link from "next/link";
import { StatePanel } from "@/components/feedback/state-panel";
import { buttonVariants } from "@/components/ui/button";

export const metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <StatePanel
      titleAs="h1"
      eyebrow="404"
      title="Off the edge of the map"
      description="This page isn't on the atlas. It may have moved, or never existed."
      actions={
        <>
          <Link href="/" className={buttonVariants()}>
            Back to Compute Atlas
          </Link>
          <Link href="/explore" className={buttonVariants({ variant: "outline" })}>
            Explore the data
          </Link>
        </>
      }
    />
  );
}
