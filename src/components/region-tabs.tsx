import Link from "next/link";
import { REGION_ORDER, REGION_LABELS, isRegion } from "@/lib/regions";

/**
 * Region selector rendered as links (?region=…). `basePath` is the current page.
 * `current` is the active region slug ("all" or a Region).
 */
export function RegionTabs({
  basePath,
  current,
}: {
  basePath: string;
  current?: string;
}) {
  const active = isRegion(current) ? current : "all";
  const tabs: { key: string; label: string }[] = [
    { key: "all", label: "All" },
    ...REGION_ORDER.map((r) => ({ key: r, label: REGION_LABELS[r] })),
  ];
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-1 text-sm">
      {tabs.map((t) => {
        const href = t.key === "all" ? basePath : `${basePath}?region=${t.key}`;
        const isActive = active === t.key;
        return (
          <Link
            key={t.key}
            href={href}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              isActive
                ? "bg-accent text-black font-medium"
                : "text-muted hover:text-foreground hover:bg-surface-2"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Small region badge. */
export function RegionBadge({ region }: { region?: string | null }) {
  if (!isRegion(region)) {
    return <span className="text-[10px] uppercase tracking-wide text-muted">Other</span>;
  }
  return (
    <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-surface-2 text-muted">
      {REGION_LABELS[region]}
    </span>
  );
}
