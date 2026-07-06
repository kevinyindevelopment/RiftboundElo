import Link from "next/link";
import { Card } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { LocalTime } from "@/components/local-time";

type EventLike = {
  id: string;
  name: string;
  format?: string | null;
  gameplayFormat?: string | null;
  status?: string | null;
  startDatetime?: Date | null;
  numPlayers?: number;
  capacity?: number | null;
  costCents?: number | null;
  currency?: string | null;
  store?: { id: string; name: string; city?: string | null; state?: string | null } | null;
  _count?: { entries: number };
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const s = status.toLowerCase();
  const map: Record<string, string> = {
    upcoming: "bg-accent-2/15 text-accent-2",
    inprogress: "bg-win/15 text-win",
    complete: "bg-surface-2 text-muted",
    completed: "bg-surface-2 text-muted",
  };
  const label = s === "inprogress" ? "Live" : status[0].toUpperCase() + status.slice(1);
  return (
    <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${map[s] ?? "bg-surface-2 text-muted"}`}>
      {label}
    </span>
  );
}

function cost(cents?: number | null, currency?: string | null): string {
  if (cents == null || cents === 0) return "Free";
  return `${(cents / 100).toLocaleString("en-US", { style: "currency", currency: currency || "USD" })}`;
}

export function EventList({ events }: { events: EventLike[] }) {
  if (events.length === 0)
    return <Card className="px-6 py-8 text-center text-muted">No events.</Card>;
  const nowMs = Date.now();
  return (
    <Card className="divide-y divide-border/60">
      {events.map((e) => {
        // Upcoming events show the start time; past events just the date.
        const upcoming =
          e.status?.toLowerCase() === "upcoming" ||
          (e.startDatetime != null && new Date(e.startDatetime).getTime() > nowMs);
        return (
        <Link
          key={e.id}
          href={`/events/${e.id}`}
          className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/50 transition-colors"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{e.name}</span>
              <StatusBadge status={e.status} />
            </div>
            <div className="text-xs text-muted truncate mt-0.5">
              {e.store?.name}
              {e.store?.city ? ` · ${e.store.city}${e.store.state ? `, ${e.store.state}` : ""}` : ""}
              {e.format ? ` · ${e.format}` : ""}
              {e.gameplayFormat ? ` · ${e.gameplayFormat}` : ""}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm tabular-nums">
              {(e._count?.entries || e.numPlayers || 0)}
              {e.capacity ? <span className="text-muted">/{e.capacity}</span> : ""}
              <span className="text-muted"> players</span>
            </div>
            <div className="text-xs text-muted">
              {upcoming && e.startDatetime ? (
                <LocalTime
                  ms={new Date(e.startDatetime).getTime()}
                  fallback={fmtDateTime(e.startDatetime)}
                  withTime
                />
              ) : (
                fmtDate(e.startDatetime)
              )}
              {" · "}
              {cost(e.costCents, e.currency)}
            </div>
          </div>
        </Link>
        );
      })}
    </Card>
  );
}
