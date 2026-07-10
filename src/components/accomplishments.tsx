"use client";

import { useState } from "react";
import Link from "next/link";

/** One notable competitive result, as produced by `getPlayerAccomplishments`. */
export type AccoBadge = {
  key: string;
  emoji: string;
  label: string;
  title: string;
  tier: "gold" | "silver" | "bronze";
  eventId: string;
};

const TIER: Record<AccoBadge["tier"], string> = {
  gold: "bg-accent/15 text-accent border-accent/30",
  silver: "bg-accent-2/15 text-accent-2 border-accent-2/30",
  bronze: "bg-surface-2/70 text-foreground/90 border-border",
};

// How many badges stay visible when collapsed. Only collapse when hiding at
// least two — otherwise the "+N more" chip costs as much room as it saves.
const COLLAPSED = 6;

/**
 * A wrap-around row of accomplishment pills, each linking to its event. When a
 * player has many, it collapses to the top few with a "+N more" toggle so the
 * profile header stays compact.
 */
export function Accomplishments({ items }: { items: AccoBadge[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;

  const overflow = items.length > COLLAPSED + 1;
  const shown = open || !overflow ? items : items.slice(0, COLLAPSED);
  const hidden = items.length - shown.length;

  return (
    <section>
      <h2 className="text-xs uppercase tracking-wide text-muted mb-2">
        Accomplishments <span className="text-muted/70">({items.length})</span>
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((a) => (
          <Link
            key={a.key}
            href={`/events/${a.eventId}`}
            title={a.title}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition hover:brightness-110 ${TIER[a.tier]}`}
          >
            <span aria-hidden>{a.emoji}</span>
            <span>{a.label}</span>
          </Link>
        ))}
        {overflow && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted transition hover:bg-surface-2/60 hover:text-foreground"
          >
            {open ? "Show less" : `+${hidden} more`}
          </button>
        )}
      </div>
    </section>
  );
}
