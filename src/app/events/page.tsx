import { getUpcomingEvents, getRecentEvents } from "@/lib/queries";
import { PageTitle } from "@/components/ui";
import { EventList } from "@/components/events";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const [upcoming, past] = await Promise.all([
    getUpcomingEvents(50),
    getRecentEvents(100),
  ]);

  return (
    <div className="space-y-6">
      <PageTitle title="Events" subtitle={`${upcoming.length} upcoming · ${past.length} past`} />

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
