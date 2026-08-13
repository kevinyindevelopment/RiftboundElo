import { getPlayersByAttendance, hasEloData } from "@/lib/queries";
import { Card, PageTitle, PlayerLink, ProvisionalMark } from "@/components/ui";
import { RegionTabs } from "@/components/region-tabs";
import { pct, winRate } from "@/lib/format";
import { isRegion, REGION_LABELS } from "@/lib/regions";

// See src/lib/cache.ts — `force-dynamic` would disable the query cache.
export const revalidate = 300;

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const [players, elo] = await Promise.all([
    getPlayersByAttendance(400, region),
    hasEloData(),
  ]);
  const scope = isRegion(region) ? `${REGION_LABELS[region]} · ` : "";

  return (
    <div>
      <PageTitle
        title="Players"
        subtitle={`${scope}${players.length} players${elo ? "" : " · ranked by event attendance"}`}
      />
      <div className="mb-4">
        <RegionTabs basePath="/players" current={region} />
      </div>

      {players.length === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          No players yet. Ingest events with published rosters via{" "}
          <code className="text-accent-2">npm run ingest:stores -- --decklists</code>.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
              <tr>
                <th className="text-right py-2.5 px-3 w-14">#</th>
                <th className="text-left py-2.5 px-3">Player</th>
                <th className="text-right py-2.5 px-3">Events</th>
                {elo && <th className="text-right py-2.5 px-3">Elo</th>}
                {elo && <th className="text-right py-2.5 px-3">W-L-D</th>}
                {elo && <th className="text-right py-2.5 px-3 hidden sm:table-cell">Win %</th>}
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                  <td className="text-right py-2 px-3 tabular-nums text-muted">{i + 1}</td>
                  <td className="py-2 px-3">
                    <PlayerLink id={p.id} name={p.displayName} handle={p.handle} />
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">{p._count.entries}</td>
                  {elo && (
                    <td className="text-right py-2 px-3 tabular-nums font-semibold text-accent">
                      {p.rating}
                      <ProvisionalMark rd={p.ratingDeviation} />
                    </td>
                  )}
                  {elo && (
                    <td className="text-right py-2 px-3 tabular-nums">{p.wins}-{p.losses}-{p.draws}</td>
                  )}
                  {elo && (
                    <td className="text-right py-2 px-3 tabular-nums text-muted hidden sm:table-cell">
                      {pct(winRate(p.wins, p.losses, p.draws))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
