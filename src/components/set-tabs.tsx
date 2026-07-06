import Link from "next/link";
import { SET_ORDER, SET_LABELS, isSetCode } from "@/lib/sets";

/**
 * Set-release selector rendered as links (?set=…). `basePath` is the current
 * page. `current` is the active set code ("all" or a SetCode). Preserves any
 * other query params passed via `extraParams`.
 */
export function SetTabs({
  basePath,
  current,
  extraParams,
}: {
  basePath: string;
  current?: string;
  extraParams?: Record<string, string | undefined>;
}) {
  const active = isSetCode(current) ? current : "all";
  const tabs: { key: string; label: string }[] = [
    { key: "all", label: "All sets" },
    ...SET_ORDER.map((c) => ({ key: c, label: SET_LABELS[c] })),
  ];
  const hrefFor = (key: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
    // Always emit the set param, including `set=all`, so a page can default a
    // bare URL to something other than "all" (the metagame defaults to the
    // current set) while "All sets" stays explicitly reachable.
    params.set("set", key);
    return `${basePath}?${params.toString()}`;
  };
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-1 text-sm">
      {tabs.map((t) => {
        const isActive = active === t.key;
        return (
          <Link
            key={t.key}
            href={hrefFor(t.key)}
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

/** Small set-release badge. */
export function SetBadge({ code }: { code?: string | null }) {
  if (!isSetCode(code)) return null;
  return (
    <span
      className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-surface-2 text-muted"
      title={`Played during the ${SET_LABELS[code]} set`}
    >
      {SET_LABELS[code]}
    </span>
  );
}
