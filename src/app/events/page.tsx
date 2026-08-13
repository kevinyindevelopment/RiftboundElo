import { getUpcomingEvents, getRecentEvents } from "@/lib/queries";
import { PageTitle } from "@/components/ui";
import { EventList } from "@/components/events";
import { RegionTabs } from "@/components/region-tabs";
import { isRegion, REGION_LABELS } from "@/lib/regions";

// See src/lib/cache.ts — `force-dynamic` would disable the query cache. Kept
// short because the event list visibly moves on event days.
export const revalidate = 600;

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const [upcoming, past] = await Promise.all([
    getUpcomingEvents(50, region),
    getRecentEvents(150, region),
  ]);
  const scope = isRegion(region) ? `${REGION_LABELS[region]} · ` : "";

  return (
    <div className="space-y-6">
      <PageTitle title="Events" subtitle={`${scope}${upcoming.length} upcoming · ${past.length} past`} />
      <div>
        <RegionTabs basePath="/events" current={region} />
      </div>

      {upcoming.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Upcoming</h2>
          <EventList events={upcoming} />
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Past</h2>
        <EventList events={past} />
      </section>
    </div>
  );
}
