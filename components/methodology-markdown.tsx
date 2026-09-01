import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

import { resolveMethodologyLink } from "@/lib/methodology";

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * Maps `docs/methodology.md`'s markdown elements onto the atlas theme's
 * existing tokens (font-display headings, muted-foreground body text,
 * border-border rules) — the same tokens `app/about/page.tsx` and
 * `app/support/page.tsx` use, since the theme is locked and this page must
 * not introduce new ones. `scroll-mt-24` on headings keeps an in-page anchor
 * jump (e.g. `/methodology#cooling-type`, the id `rehype-slug` assigns) from
 * landing under the sticky header.
 *
 * `## Cooling type` -> id `cooling-type`, matching the anchor
 * `scripts/discovery/extract-fields.ts` cites in a comment
 * (`docs/methodology.md#cooling-type`) and the drift test guarding it.
 */
const components: Components = {
  h2(props) {
    const { children, id } = props;
    return (
      <h2
        id={id}
        className="scroll-mt-24 font-display text-2xl text-foreground border-t border-border pt-10 mt-10 first:mt-0 first:border-t-0 first:pt-0"
      >
        {children}
      </h2>
    );
  },
  h3(props) {
    const { children, id } = props;
    return (
      <h3 id={id} className="scroll-mt-24 font-display text-xl text-foreground pt-2">
        {children}
      </h3>
    );
  },
  p({ children }) {
    return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
  },
  strong({ children }) {
    return <strong className="font-medium text-foreground">{children}</strong>;
  },
  ul({ children }) {
    return (
      <ul className="list-disc list-outside pl-5 space-y-2 text-sm text-muted-foreground">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="list-decimal list-outside pl-5 space-y-2 text-sm text-muted-foreground">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  code({ children }) {
    return (
      <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto border border-border rounded-md">
        <table className="w-full text-left text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="border-b border-border bg-muted/50">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="px-3 py-2 align-top text-muted-foreground border-t border-border">{children}</td>;
  },
  a(props) {
    const { children, href = "" } = props;
    const resolved = resolveMethodologyLink(href);
    const isExternal = resolved !== href || /^[a-z][a-z0-9+.-]*:/i.test(resolved);
    return (
      <a
        href={resolved}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noreferrer noopener" : undefined}
        className={LINK_CLASS}
      >
        {children}
      </a>
    );
  },
};

/**
 * Renders `docs/methodology.md` itself (server component — see
 * lib/methodology.ts). Deliberately does NOT copy the doc's prose into TSX:
 * the page can only ever say what the file says.
 */
export function MethodologyMarkdown({ source }: { source: string }) {
  return (
    <div className="space-y-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
