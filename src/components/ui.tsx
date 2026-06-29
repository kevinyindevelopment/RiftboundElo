import Link from "next/link";
import { parseDomains } from "@/lib/format";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface ${className}`}
    >
      {children}
    </div>
  );
}

export function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-0.5">{value}</div>
    </Card>
  );
}

export function PageTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {subtitle && <p className="text-muted text-sm mt-1">{subtitle}</p>}
    </div>
  );
}

export function ResultBadge({ result }: { result: "win" | "loss" | "draw" }) {
  const map = {
    win: "bg-win/15 text-win",
    loss: "bg-loss/15 text-loss",
    draw: "bg-draw/15 text-draw",
  } as const;
  return (
    <span className={`inline-block w-5 text-center rounded text-xs font-bold py-0.5 ${map[result]}`}>
      {result[0].toUpperCase()}
    </span>
  );
}

export function Delta({ value }: { value: number }) {
  const cls = value > 0 ? "text-win" : value < 0 ? "text-loss" : "text-muted";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`tabular-nums font-medium ${cls}`}>
      {sign}
      {value}
    </span>
  );
}

const DOMAIN_CLASS: Record<string, string> = {
  body: "domain-body",
  calm: "domain-calm",
  chaos: "domain-chaos",
  fury: "domain-fury",
  mind: "domain-mind",
  order: "domain-order",
};

export function DomainDots({ domains }: { domains: string | string[] | null | undefined }) {
  const list = Array.isArray(domains) ? domains : parseDomains(domains);
  if (!list.length) return null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {list.map((d) => (
        <span
          key={d}
          title={d}
          className={`inline-block h-2.5 w-2.5 rounded-full ${DOMAIN_CLASS[d.toLowerCase()] ?? "bg-muted"}`}
        />
      ))}
    </span>
  );
}

/** Renders the gamer tag first, then the full/real name (muted) after it. */
export function PlayerName({
  handle,
  name,
}: {
  handle?: string | null;
  name?: string | null;
}) {
  const tag = handle || name || "—";
  const realName = handle && name && handle !== name ? name : null;
  return (
    <>
      <span className="font-medium">{tag}</span>
      {realName && <span className="text-muted font-normal ml-1.5">{realName}</span>}
    </>
  );
}

export function PlayerLink({
  id,
  name,
  handle,
  className = "",
}: {
  id: string;
  name?: string | null;
  handle?: string | null;
  className?: string;
}) {
  return (
    <Link href={`/players/${id}`} className={`hover:text-accent transition-colors ${className}`}>
      <PlayerName handle={handle} name={name} />
    </Link>
  );
}

/** Tiny inline SVG sparkline of rating over time. */
export function RatingSparkline({
  points,
  width = 720,
  height = 140,
}: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <div className="text-muted text-sm">Not enough games to chart yet.</div>;
  }
  const pad = 8;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (p - min) / range);
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  const last = points[points.length - 1];
  const first = points[0];
  const up = last >= first;
  const stroke = up ? "var(--win)" : "var(--loss)";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" preserveAspectRatio="none">
      <path d={area} fill={stroke} opacity={0.08} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
      <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r={3} fill={stroke} />
    </svg>
  );
}
