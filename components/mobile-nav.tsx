"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Menu, X } from "lucide-react";

interface NavGroup {
  readonly label: string;
  readonly links: readonly {
    readonly label: string;
    readonly href: string;
    readonly external?: boolean;
  }[];
}

interface MobileNavProps {
  readonly groups: readonly NavGroup[];
}

const LINK_CLASSNAME =
  "flex min-h-11 w-full items-center gap-1 rounded-sm px-2 font-mono text-sm uppercase tracking-wider text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-[current=page]:text-foreground";

export function MobileNav({ groups }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const close = () => setOpen(false);

  return (
    <>
      {/*
        This toggle intentionally still swaps its aria-label/aria-expanded to a
        "Close…" state when open, but Base UI's default `modal` Dialog makes it
        pointer/AT-inert while the panel is open (it sits outside Dialog.Root's
        tree), so the panel's own close button below is the only one exposed to
        the accessibility tree at that point — both share the same accessible
        name by design, not a duplicate-label bug.
      */}
      <button
        type="button"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:hidden"
      >
        {open ? (
          <X aria-hidden className="size-5" />
        ) : (
          <Menu aria-hidden className="size-5" />
        )}
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 transition-opacity duration-200 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup
            id="mobile-nav-panel"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xs translate-x-0 flex-col overflow-y-auto border-l border-border bg-background shadow-lg transition-transform duration-200 ease-in-out motion-reduce:transition-none data-ending-style:translate-x-full data-starting-style:translate-x-full"
          >
            <Dialog.Description className="sr-only">
              Site navigation. Press Escape or the close button to dismiss.
            </Dialog.Description>

            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <Dialog.Title className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Navigation
              </Dialog.Title>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={close}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <X aria-hidden className="size-5" />
              </button>
            </div>

            <nav aria-label="Mobile navigation" className="flex-1 overflow-y-auto px-2 py-4">
              {groups.map((group) => (
                <div key={group.label} className="mb-6 last:mb-0">
                  <p className="px-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    {group.label}
                  </p>
                  <ul>
                    {group.links.map((link) => {
                      const isActive = !link.external && pathname === link.href;
                      return (
                        <li key={link.href}>
                          {link.external ? (
                            <a
                              href={link.href}
                              target="_blank"
                              rel="noreferrer noopener"
                              aria-label={`${link.label} (opens in new tab)`}
                              onClick={close}
                              className={LINK_CLASSNAME}
                            >
                              {link.label}
                              <span aria-hidden="true" className="ml-1">
                                ↗
                              </span>
                            </a>
                          ) : (
                            <Link
                              href={link.href}
                              aria-current={isActive ? "page" : undefined}
                              onClick={close}
                              className={LINK_CLASSNAME}
                            >
                              {link.label}
                            </Link>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
