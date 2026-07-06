"use client";

import { useRouter } from "next/navigation";
import { REGION_ORDER, REGION_LABELS, isRegion } from "@/lib/regions";

/**
 * Region selector as a dropdown (the flat tab row got too crowded once the
 * Michigan + California metros were added). Navigates to ?region=… on change.
 * `basePath` is the current page; `current` is the active slug ("all" or a Region).
 */
export function RegionSelect({
  basePath,
  current,
}: {
  basePath: string;
  current?: string;
}) {
  const router = useRouter();
  const active = isRegion(current) ? current : "all";
  const options = [
    { key: "all", label: "All Regions" },
    ...REGION_ORDER.map((r) => ({ key: r, label: REGION_LABELS[r] })),
  ];
  const hrefFor = (key: string) => (key === "all" ? basePath : `${basePath}?region=${key}`);
  return (
    <div className="relative inline-block">
      <select
        aria-label="Region"
        value={active}
        onChange={(e) => router.push(hrefFor(e.target.value))}
        className="appearance-none rounded-lg border border-border bg-surface pl-3 pr-9 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-accent cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key} className="bg-surface text-foreground">
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  );
}
