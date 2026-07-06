"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Global search input. Navigates to /search?q=… on submit. Lives in the header,
 * so it's uncontrolled re: the URL — `initial` just seeds the box on the search page.
 */
export function SearchBar({
  initial = "",
  className = "",
}: {
  initial?: string;
  className?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initial);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        if (term) router.push(`/search?q=${encodeURIComponent(term)}`);
      }}
      className={`relative ${className}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        name="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search players, stores…"
        aria-label="Search players and stores"
        className="w-full rounded-md border border-border bg-surface-2/60 pl-8 pr-3 py-1.5 text-sm placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
      />
    </form>
  );
}
