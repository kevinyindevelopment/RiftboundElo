import { REGION_LABELS, isRegion } from "@/lib/regions";
import { RegionSelect } from "@/components/region-select";

/**
 * Region selector. Renders a dropdown (see RegionSelect) — the flat tab row
 * outgrew its space once the MI/CA metros were added. `basePath` is the current
 * page; `current` is the active region slug ("all" or a Region).
 */
export function RegionTabs({
  basePath,
  current,
}: {
  basePath: string;
  current?: string;
}) {
  return <RegionSelect basePath={basePath} current={current} />;
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
