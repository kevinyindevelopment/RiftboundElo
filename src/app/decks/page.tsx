import { getMetagame } from "@/lib/queries";
import { Card, PageTitle } from "@/components/ui";
import { pct } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DecksPage() {
  const meta = await getMetagame();
  const totalGames = meta.reduce((s, m) => s + m.wins + m.losses + m.draws, 0);

  return (
    <div>
      <PageTitle
        title="Metagame"
        subtitle="Win rates and play rates aggregated by Legend across all tracked matches."
      />

      {meta.length === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          No deck/match data yet. Seed demo data or ingest events with results.
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
                const wr = games ? m.wins / games : 0;
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
