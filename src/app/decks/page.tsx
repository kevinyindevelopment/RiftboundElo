import { getMetagame } from "@/lib/queries";
import { Card, PageTitle } from "@/components/ui";
import { SetTabs } from "@/components/set-tabs";
import { pct, winRate } from "@/lib/format";
import { isSetCode, SET_LABELS, SET_ORDER, setForDate, type SetCode } from "@/lib/sets";

// See src/lib/cache.ts — `force-dynamic` would disable the query cache, and the
// metagame aggregate this page runs is the most expensive query in the app.
export const revalidate = 900;

export default async function DecksPage({
  searchParams,
}: {
  searchParams: Promise<{ set?: string }>;
}) {
  const { set } = await searchParams;
  // Default a bare /decks to the CURRENT (live) set — "All sets" is the least
  // useful metagame view. Explicit `?set=all` aggregates everything; a valid
  // set code shows that set. The current set advances automatically by date.
  const currentSet = setForDate(new Date(), "global") ?? SET_ORDER[SET_ORDER.length - 1];
  const active: SetCode | undefined =
    set === "all" ? undefined : isSetCode(set) ? set : currentSet;
  const meta = await getMetagame(active);
  const totalGames = meta.reduce((s, m) => s + m.wins + m.losses + m.draws, 0);

  const subtitle = active
    ? `Win rates and play rates by Legend during the ${SET_LABELS[active]} set — bucketed by each event's play date.`
    : "Win rates and play rates aggregated by Legend across all tracked matches.";

  return (
    <div>
      <PageTitle title="Metagame" subtitle={subtitle} />
      <div className="mb-4">
        <SetTabs basePath="/decks" current={active ?? "all"} />
      </div>

      {meta.length === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          {active
            ? `No deck/match data recorded during the ${SET_LABELS[active]} set yet.`
            : "No deck/match data yet. Seed demo data or ingest events with results."}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
              <tr>
                <th className="text-left py-2.5 px-3">Legend</th>
                <th className="text-right py-2.5 px-3">Games</th>
                <th className="text-right py-2.5 px-3 hidden sm:table-cell">Meta share</th>
                <th className="text-right py-2.5 px-3">W-L-D</th>
                <th className="text-right py-2.5 px-3">Win %</th>
                <th className="text-left py-2.5 px-3 w-1/4 hidden md:table-cell"> </th>
              </tr>
            </thead>
            <tbody>
              {meta.map((m) => {
                const games = m.wins + m.losses + m.draws;
                const wr = winRate(m.wins, m.losses, m.draws);
                const share = totalGames ? games / totalGames : 0;
                return (
                  <tr key={m.legend} className="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td className="py-2 px-3 font-medium">{m.legend}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted">{games}</td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted hidden sm:table-cell">{pct(share)}</td>
                    <td className="text-right py-2 px-3 tabular-nums">{m.wins}-{m.losses}-{m.draws}</td>
                    <td className="text-right py-2 px-3 tabular-nums font-semibold">{pct(wr)}</td>
                    <td className="py-2 px-3 hidden md:table-cell">
                      <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className="h-full bg-accent"
                          style={{ width: `${Math.min(100, wr * 100).toFixed(0)}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
