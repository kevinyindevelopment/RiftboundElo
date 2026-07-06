"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Mobile header menu. The inline nav is hidden below `md`; this renders a
 * hamburger that toggles a full-width dropdown of the same links. Closes on
 * navigation, on Escape, and on backdrop tap.
 */
export function MobileNav({ items }: { items: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close whenever the route changes (link tapped, back button, etc.). Adjusting
  // state during render when a tracked value changes is React's recommended
  // pattern — an effect that only calls setState would fire an extra render.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>

      {open && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-x-0 bottom-0 top-14 z-20 bg-black/50"
          />
          <nav className="fixed inset-x-0 top-14 z-30 border-b border-border bg-surface/95 backdrop-blur">
            <ul className="mx-auto max-w-6xl px-2 py-2">
              {items.map((n) => (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    className={`block rounded-md px-3 py-2.5 text-sm transition-colors ${
                      isActive(n.href)
                        ? "text-accent bg-surface-2"
                        : "text-muted hover:text-foreground hover:bg-surface-2"
                    }`}
                  >
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      )}
    </div>
  );
}
