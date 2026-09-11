"use client";

import { Copy } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";

interface StateEmbedSnippetProps {
  snippet: string;
  stateName: string;
}

/**
 * Renders the copyable <iframe> embed snippet on a state hub
 * (app/states/[state]/page.tsx, a Server Component) plus its copy control.
 * Split into its own "use client" component because the copy control needs
 * the Clipboard API — see that file's client/server boundary note. The
 * snippet string itself is built server-side and passed in as a plain
 * string prop, so nothing server-only crosses the boundary.
 */
export function StateEmbedSnippet({ snippet, stateName }: StateEmbedSnippetProps) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border bg-muted/50">
        <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground">
          <code>{snippet}</code>
        </pre>
      </div>
      <CopyButton
        getText={() => snippet}
        label="Copy snippet"
        ariaLabel={`Copy the embeddable map snippet for ${stateName}`}
        successMessage="Embed snippet copied to clipboard"
        errorMessage="Couldn't copy the embed snippet"
        icon={Copy}
      />
    </div>
  );
}
