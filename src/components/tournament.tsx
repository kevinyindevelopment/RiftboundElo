import { DomainDots, PlayerLink, ProvisionalMark } from "@/components/ui";
import { ordinal, pct } from "@/lib/format";
import type { Bubble, BubbleState, LegendRace, Standing } from "@/lib/tournament";

const BUBBLE_LABEL: Record<BubbleState, string> = {
  in: "In",
  alive: "Bubble",
  out: "Out",
};
const BUBBLE_CLASS: Record<BubbleState, string> = {
  in: "bg-win/15 text-win",
  alive: "bg-draw/15 text-draw",
  out: "bg-loss/15 text-loss",
};

function BubbleBadge({ state }: { state: BubbleState }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${BUBBLE_CLASS[state]}`}>
      {BUBBLE_LABEL[state]}
    </span>
  );
}

/** Two-tone bar showing player A's win probability (left) vs B's (right). */
export function WinProbBar({ pA }: { pA: number }) {
  const a = Math.round(pA * 100);
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-loss/40">
      <div className="bg-win" style={{ width: `${a}%` }} />
    </div>
  );
}

export function StandingsTable({
  standings,
  bubble,
  odds,
  highlightLegend,
}: {
  standings: Standing[];
  bubble: Map<string, Bubble> | null;
  odds: Map<string, number> | null;
  highlightLegend?: string | null;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
        <tr>
          <th className="text-right py-1.5 pr-2 w-8">#</th>
          <th className="text-left py-1.5">Player</th>
          <th className="text-right py-1.5" title="Match record (W-L-D)">Record</th>
          <th className="text-right py-1.5">Pts</th>
          <th className="text-right py-1.5 hidden sm:table-cell" title="Opponents' match-win % (primary tiebreaker)">OMW%</th>
          {bubble && <th className="text-right py-1.5" title="Provable Top-cut status">Cut</th>}
          {odds && <th className="text-right py-1.5 hidden md:table-cell" title="Estimated Top-cut probability (Monte-Carlo)">Odds</th>}
          {bubble && <th className="text-left py-1.5 pl-3 hidden lg:table-cell">Next round</th>}
        </tr>
      </thead>
      <tbody>
        {standings.map((s) => {
          const b = bubble?.get(s.playerId);
          const o = odds?.get(s.playerId);
          const games = s.wins + s.losses + s.draws;
          const hl = highlightLegend && s.legend === highlightLegend;
          return (
            <tr
              key={s.playerId}
              className={`border-b border-border/50 last:border-0 ${hl ? "bg-accent/5" : ""}`}
            >
              <td className="py-1.5 pr-2 text-muted tabular-nums text-right">{s.rank}</td>
              <td className="py-1.5">
                <PlayerLink id={s.playerId} name={s.displayName} handle={s.handle} />
                {s.legend && (
                  <span className="ml-2 text-xs text-muted inline-flex items-center gap-1 align-middle">
                    {s.legend}
                    <DomainDots domains={s.domains} />
                  </span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums whitespace-nowrap">
                {games > 0 ? `${s.wins}-${s.losses}-${s.draws}` : "—"}
              </td>
              <td className="py-1.5 text-right tabular-nums font-semibold">{s.points}</td>
              <td className="py-1.5 text-right tabular-nums text-muted hidden sm:table-cell">
                {(s.omw * 100).toFixed(1)}%
              </td>
              {bubble && (
                <td className="py-1.5 text-right">{b && <BubbleBadge state={b.state} />}</td>
              )}
              {odds && (
                <td className="py-1.5 text-right tabular-nums text-muted hidden md:table-cell">
                  {o == null ? "—" : o >= 0.999 ? "✓" : o <= 0.001 ? "—" : pct(o)}
                </td>
              )}
              {bubble && (
                <td className="py-1.5 pl-3 text-xs text-muted hidden lg:table-cell">{b?.advice}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export interface PendingPairing {
  id: string;
  one: Standing;
  two: Standing;
  pA: number; // player one's win probability
}

export function PendingPairings({ pairings }: { pairings: PendingPairing[] }) {
  return (
    <ul className="space-y-3">
      {pairings.map((p) => (
        <li key={p.id} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">
              <PlayerLink id={p.one.playerId} name={p.one.displayName} handle={p.one.handle} />
              {p.one.legend && <span className="text-muted text-xs ml-1.5">{p.one.legend}</span>}
            </span>
            <span className="tabular-nums text-xs shrink-0">
              <span className="font-semibold">{Math.round(p.pA * 100)}%</span>
              <span className="text-muted mx-1">/</span>
              <span className="text-muted">{Math.round((1 - p.pA) * 100)}%</span>
            </span>
            <span className="min-w-0 truncate text-right">
              {p.two.legend && <span className="text-muted text-xs mr-1.5">{p.two.legend}</span>}
              <PlayerLink id={p.two.playerId} name={p.two.displayName} handle={p.two.handle} />
            </span>
          </div>
          <WinProbBar pA={p.pA} />
          <div className="flex justify-between text-[11px] text-muted tabular-nums">
            <span>
              {p.one.points} pts · {Math.round(p.one.rating)}
              <ProvisionalMark rd={p.one.rd} />
            </span>
            <span>
              {Math.round(p.two.rating)}
              <ProvisionalMark rd={p.two.rd} /> · {p.two.points} pts
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LegendRaceList({
  races,
  topN = 3,
}: {
  races: LegendRace[];
  topN?: number;
}) {
  return (
    <div className="space-y-4">
      {races.map((race) => {
        const leader = race.pilots[0];
        return (
          <div key={race.legend}>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <div className="text-sm font-medium inline-flex items-center gap-1.5">
                {race.legend}
                <DomainDots domains={race.domains} />
              </div>
              <span className="text-xs text-muted">
                {race.pilots.length} pilot{race.pilots.length === 1 ? "" : "s"}
              </span>
            </div>
            <ol className="text-sm space-y-0.5">
              {race.pilots.slice(0, topN).map((p, i) => (
                <li key={p.playerId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className={`tabular-nums mr-1.5 ${i === 0 ? "text-accent font-semibold" : "text-muted"}`}>
                      {i === 0 ? "★" : ordinal(i + 1)}
                    </span>
                    <PlayerLink id={p.playerId} name={p.displayName} handle={p.handle} />
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-muted whitespace-nowrap">
                    {p.points} pts · {p.wins}-{p.losses}-{p.draws} · {ordinal(p.rank)} overall
                  </span>
                </li>
              ))}
            </ol>
            {race.pilots.length > topN && (
              <div className="text-[11px] text-muted mt-0.5">
                +{race.pilots.length - topN} more chasing {leader.handle || leader.displayName}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
