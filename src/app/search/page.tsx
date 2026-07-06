import Link from "next/link";
import { searchAll } from "@/lib/queries";
import { Card, PageTitle, PlayerLink, ProvisionalMark } from "@/components/ui";
import { regionLabel } from "@/lib/regions";
import { fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

type Cursor = "pp" | "sp" | "ep";
type Cursors = { pp: number; sp: number; ep: number };

function toPage(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Build a /search URL preserving q + all page cursors, overriding one. */
function searchHref(q: string, cur: Cursors, override: Partial<Cursors>): string {
  const params = new URLSearchParams({ q });
  const merged = { ...cur, ...override };
  if (merged.pp > 1) params.set("pp", String(merged.pp));
  if (merged.sp > 1) params.set("sp", String(merged.sp));
  if (merged.ep > 1) params.set("ep", String(merged.ep));
  return `/search?${params.toString()}`;
}

function Pager({
  q,
  cur,
  which,
  page,
  pages,
  total,
  pageSize,
}: {
  q: string;
  cur: Cursors;
  which: Cursor;
  page: number;
  pages: number;
  total: number;
  pageSize: number;
}) {
  if (pages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const linkCls =
    "px-2.5 py-1 rounded-md border border-border text-sm hover:bg-surface-2/60";
  const disabledCls =
    "px-2.5 py-1 rounded-md border border-border/50 text-sm text-muted/50 pointer-events-none";
  return (
    <div className="flex items-center justify-between gap-3 mt-3 text-sm">
      <span className="text-muted tabular-nums">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={searchHref(q, cur, { [which]: page - 1 })} className={linkCls}>
            ← Prev
          </Link>
        ) : (
          <span className={disabledCls}>← Prev</span>
        )}
        <span className="text-muted tabular-nums">
          {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={searchHref(q, cur, { [which]: page + 1 })} className={linkCls}>
            Next →
          </Link>
        ) : (
          <span className={disabledCls}>Next →</span>
        )}
      </div>
    </div>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; pp?: string; sp?: string; ep?: string }>;
}) {
  const { q = "", pp, sp, ep } = await searchParams;
  const result = await searchAll(q, {
    playerPage: toPage(pp),
    storePage: toPage(sp),
    eventPage: toPage(ep),
  });
  const {
    term,
    players,
    stores,
    events,
    playersTotal,
    storesTotal,
    eventsTotal,
    playerPage,
    storePage,
    eventPage,
    playerPages,
    storePages,
    eventPages,
    pageSize,
  } = result;
  const cur: Cursors = { pp: playerPage, sp: storePage, ep: eventPage };
  const total = playersTotal + storesTotal + eventsTotal;

  return (
    <div>
      <PageTitle
        title="Search"
        subtitle={
          term
            ? `${total} result${total === 1 ? "" : "s"} for "${term}"`
            : "Find a player, store, or event"
        }
      />

      {!term ? (
        <Card className="px-6 py-10 text-center text-muted">
          Type a player, store, or event name in the search box above.
        </Card>
      ) : total === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          Nothing matches <span className="text-foreground">"{term}"</span>.
        </Card>
      ) : (
        <div className="space-y-8">
          {playersTotal > 0 && (
            <section>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="text-lg font-semibold">Players</h2>
                <span className="text-xs text-muted">{playersTotal}</span>
              </div>
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
                    <tr>
                      <th className="text-left py-2.5 px-3">Player</th>
                      <th className="text-right py-2.5 px-3">Events</th>
                      <th className="text-right py-2.5 px-3">Elo</th>
                      <th className="text-right py-2.5 px-3">W-L-D</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((p) => (
                      <tr
                        key={p.id}
                        className="border-b border-border/50 last:border-0 hover:bg-surface-2/50"
                      >
                        <td className="py-2 px-3">
                          <PlayerLink id={p.id} name={p.displayName} handle={p.handle} />
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {p._count.entries}
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums font-semibold text-accent">
                          {p.rating}
                          <ProvisionalMark rd={p.ratingDeviation} />
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {p.wins}-{p.losses}-{p.draws}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Pager
                q={term}
                cur={cur}
                which="pp"
                page={playerPage}
                pages={playerPages}
                total={playersTotal}
                pageSize={pageSize}
              />
            </section>
          )}

          {eventsTotal > 0 && (
            <section>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="text-lg font-semibold">Events</h2>
                <span className="text-xs text-muted">{eventsTotal}</span>
              </div>
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="text-muted text-xs uppercase tracking-wide border-b border-border">
                    <tr>
                      <th className="text-left py-2.5 px-3">Event</th>
                      <th className="text-left py-2.5 px-3 hidden sm:table-cell">Location</th>
                      <th className="text-right py-2.5 px-3">Players</th>
                      <th className="text-right py-2.5 px-3 hidden sm:table-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr
                        key={e.id}
                        className="border-b border-border/50 last:border-0 hover:bg-surface-2/50"
                      >
                        <td className="py-2 px-3">
                          <Link href={`/events/${e.id}`} className="font-medium hover:text-accent">
                            {e.name}
                          </Link>
                        </td>
                        <td className="py-2 px-3 text-muted hidden sm:table-cell">
                          {e.store?.name
                            ? `${e.store.name}${e.store.city ? ` · ${e.store.city}${e.store.state ? `, ${e.store.state}` : ""}` : ""}`
                            : "—"}
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums">{e._count.entries}</td>
                        <td className="text-right py-2 px-3 tabular-nums text-muted hidden sm:table-cell">
                          {fmtDate(e.startDatetime)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Pager
                q={term}
                cur={cur}
                which="ep"
                page={eventPage}
                pages={eventPages}
                total={eventsTotal}
                pageSize={pageSize}
              />
            </section>
          )}

          {storesTotal > 0 && (
            <section>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="text-lg font-semibold">Stores</h2>
                <span className="text-xs text-muted">{storesTotal}</span>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {stores.map((s) => (
                  <Link key={s.id} href={`/stores/${s.id}`}>
                    <Card className="px-4 py-3 hover:bg-surface-2/50 transition-colors h-full">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted mt-0.5">
                        {[s.city, s.state].filter(Boolean).join(", ") ||
                          regionLabel(s.region)}
                      </div>
                      <div className="text-sm text-accent mt-2 tabular-nums">
                        {s._count.events} events
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
              <Pager
                q={term}
                cur={cur}
                which="sp"
                page={storePage}
                pages={storePages}
                total={storesTotal}
                pageSize={pageSize}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
