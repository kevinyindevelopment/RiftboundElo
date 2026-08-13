import Link from "next/link";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/queries";
import { PageTitle } from "@/components/ui";
import { EventList } from "@/components/events";
import { RegionBadge } from "@/components/region-tabs";

// See src/lib/cache.ts — `force-dynamic` would disable the query cache.
export const revalidate = 300;

export default async function StorePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = await getStore(id);
  if (!store) notFound();

  const now = new Date();
  const upcoming = store.events.filter((e) => e.startDatetime && e.startDatetime >= now);
  const past = store.events.filter((e) => !e.startDatetime || e.startDatetime < now);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{store.name}</h1>
            <RegionBadge region={store.region} />
          </div>
          <p className="text-muted text-sm mt-1">
            {[store.address, [store.city, store.state, store.country].filter(Boolean).join(", ")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Link href="/stores" className="text-sm text-accent-2 hover:underline">← All stores</Link>
      </div>

      {store.website && (
        <a href={store.website} target="_blank" rel="noreferrer" className="text-sm text-accent-2 hover:underline">
          {store.website}
        </a>
      )}

      {upcoming.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Upcoming ({upcoming.length})</h2>
          <EventList events={upcoming.slice().reverse()} />
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Past events ({past.length})</h2>
        <EventList events={past} />
      </section>
    </div>
  );
}
