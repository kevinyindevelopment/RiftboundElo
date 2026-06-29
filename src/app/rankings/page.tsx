import Link from "next/link";
import { getLeaderboard } from "@/lib/queries";
import { Card, PageTitle, PlayerLink } from "@/components/ui";
import { RegionTabs } from "@/components/region-tabs";
import { pct, winRate } from "@/lib/format";
import { isRegion, REGION_LABELS, REGION_SUBTITLES } from "@/lib/regions";

export const dynamic = "force-dynamic";

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const players = await getLeaderboard(200, region);

  const subtitle = isRegion(region)
    ? `${REGION_LABELS[region]} — ${REGION_SUBTITLES[region]}`
    : "Everyone starts at 1000; points transfer from the loser to the winner of each rated match.";

  return (
    <div>
      <PageTitle title="Elo Rankings" subtitle={subtitle} />
      <div className="mb-4">
        <RegionTabs basePath="/rankings" current={region} />
      </div>

      {players.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="text-lg font-medium">No rated players in this region yet.</p>
          <p className="text-muted mt-2 text-sm">
            Try another region, or browse{" "}
            <Link href="/events" className="text-accent-2 hover:underline">events</Link> and{" "}
            <Link href="/stores" className="text-accent-2 hover:underline">stores</Link>.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
              <tr>
                <th className="text-right py-2.5 px-3 w-14">#</th>
                <th className="text-left py-2.5 px-3">Player</th>
                <th className="text-right py-2.5 px-3">Elo</th>
                <th className="text-right py-2.5 px-3 hidden sm:table-cell">Peak</th>
                <th className="text-right py-2.5 px-3">W-L-D</th>
                <th className="text-right py-2.5 px-3 hidden sm:table-cell">Win %</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                  <td className="text-right py-2 px-3 tabular-nums text-muted">
                    {i < 3 ? <span className="text-accent font-bold">{i + 1}</span> : i + 1}
                  </td>
                  <td className="py-2 px-3">
                    <PlayerLink id={p.id} name={p.displayName} handle={p.handle} />
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums font-semibold text-accent">{p.rating}</td>
                  <td className="text-right py-2 px-3 tabular-nums text-muted hidden sm:table-cell">{p.peakRating}</td>
                  <td className="text-right py-2 px-3 tabular-nums">{p.wins}-{p.losses}-{p.draws}</td>
                  <td className="text-right py-2 px-3 tabular-nums text-muted hidden sm:table-cell">
                    {pct(winRate(p.wins, p.losses, p.draws))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
