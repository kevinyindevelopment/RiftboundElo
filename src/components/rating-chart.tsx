"use client";

import { useId, useState } from "react";

export type RatingPoint = {
  /** Rating value at this point. */
  rating: number;
  /** Short label for the x-axis (e.g. "Mar 3"). */
  axisDate: string;
  /** Full label for the tooltip (e.g. "Mar 3, 2026"). */
  fullDate: string;
  /** Event this match belonged to (null for the seed/starting point). */
  event: string | null;
  /** Rating delta from the previous point (null for the seed point). */
  delta: number | null;
};

const WIDTH = 720;
const HEIGHT = 200;
const M = { top: 16, right: 16, bottom: 28, left: 44 };
const PLOT_W = WIDTH - M.left - M.right;
const PLOT_H = HEIGHT - M.top - M.bottom;

/** "Nice" rounded tick values spanning [min, max]. */
function ticks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(min + step * i));
}

/**
 * Interactive rating-over-time chart: dated x-axis, rating y-axis, and a
 * hover crosshair that reads out the exact Elo, date, and event at each point.
 */
export function RatingChart({ points }: { points: RatingPoint[] }) {
  const uid = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return <div className="text-muted text-sm">Not enough games to chart yet.</div>;
  }

  const ratings = points.map((p) => p.rating);
  const lo = Math.min(...ratings);
  const hi = Math.max(...ratings);
  // Pad the range a touch so the line doesn't ride the top/bottom edge.
  const padR = Math.max(8, Math.round((hi - lo) * 0.12));
  const min = lo - padR;
  const max = hi + padR;
  const range = max - min || 1;
  const n = points.length;

  const x = (i: number) => M.left + (n === 1 ? PLOT_W / 2 : (i * PLOT_W) / (n - 1));
  const y = (v: number) => M.top + PLOT_H * (1 - (v - min) / range);

  const coords = points.map((p, i) => [x(i), y(p.rating)] as const);
  const line = coords
    .map(([cx, cy], i) => `${i === 0 ? "M" : "L"}${cx.toFixed(1)},${cy.toFixed(1)}`)
    .join(" ");
  const area =
    `${line} L${coords[n - 1][0].toFixed(1)},${(M.top + PLOT_H).toFixed(1)} ` +
    `L${coords[0][0].toFixed(1)},${(M.top + PLOT_H).toFixed(1)} Z`;

  const up = points[n - 1].rating >= points[0].rating;
  const stroke = up ? "var(--win)" : "var(--loss)";

  const yTicks = ticks(min + padR / 2, max - padR / 2, 4);

  // Sample ~6 evenly spaced indices for x-axis date labels.
  const labelCount = Math.min(6, n);
  const xTickIdx = Array.from({ length: labelCount }, (_, k) =>
    Math.round((k * (n - 1)) / (labelCount - 1 || 1)),
  );

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width; // 0..1 across the svg
    const px = ratio * WIDTH;
    const i = Math.round(((px - M.left) / PLOT_W) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hp = hover != null ? points[hover] : null;
  const hc = hover != null ? coords[hover] : null;
  // Tooltip flips to the left of the cursor once past the midpoint.
  const tipLeftPct = hc ? (hc[0] / WIDTH) * 100 : 0;
  const tipFlip = tipLeftPct > 60;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto touch-none"
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {/* y-axis gridlines + labels */}
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={WIDTH - M.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
              opacity={0.5}
            />
            <text
              x={M.left - 6}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-[var(--muted)]"
              fontSize={11}
            >
              {t}
            </text>
          </g>
        ))}

        {/* x-axis date labels */}
        {xTickIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={HEIGHT - 8}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            className="fill-[var(--muted)]"
            fontSize={11}
          >
            {points[i].axisDate}
          </text>
        ))}

        <path d={area} fill={stroke} opacity={0.08} />
        <path d={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />

        {/* hover crosshair + marker */}
        {hc && (
          <g>
            <line
              x1={hc[0]}
              x2={hc[0]}
              y1={M.top}
              y2={M.top + PLOT_H}
              stroke="var(--muted)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.7}
            />
            <circle cx={hc[0]} cy={hc[1]} r={4} fill={stroke} stroke="var(--background)" strokeWidth={1.5} />
          </g>
        )}
        {/* final-point marker when not hovering */}
        {!hc && (
          <circle cx={coords[n - 1][0]} cy={coords[n - 1][1]} r={3} fill={stroke} />
        )}
        <title id={uid}>Rating over time</title>
      </svg>

      {hp && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-y-1 rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs shadow-lg whitespace-nowrap"
          style={
            tipFlip
              ? { right: `${100 - tipLeftPct}%`, marginRight: 10 }
              : { left: `${tipLeftPct}%`, marginLeft: 10 }
          }
        >
          <div className="font-semibold tabular-nums">
            {hp.rating}
            {hp.delta != null && (
              <span className={hp.delta >= 0 ? "ml-1.5 text-[var(--win)]" : "ml-1.5 text-[var(--loss)]"}>
                {hp.delta >= 0 ? "+" : ""}
                {hp.delta}
              </span>
            )}
          </div>
          <div className="text-muted">{hp.fullDate}</div>
          {hp.event && <div className="text-muted max-w-[220px] truncate">{hp.event}</div>}
        </div>
      )}
    </div>
  );
}
