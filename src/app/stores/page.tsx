import Link from "next/link";
import { getStores } from "@/lib/queries";
import { Card, PageTitle } from "@/components/ui";
import { REGION_ORDER, REGION_LABELS, REGION_SUBTITLES, regionLabel } from "@/lib/regions";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const stores = await getStores();

  // Group by region in canonical order.
  const groups = REGION_ORDER.map((r) => ({
    key: r,
    label: REGION_LABELS[r],
    subtitle: REGION_SUBTITLES[r],
    stores: stores.filter((s) => (s.region ?? "other") === r),
  })).filter((g) => g.stores.length > 0);

  return (
    <div className="space-y-8">
      <PageTitle title="Stores" subtitle={`${stores.length} stores across the region`} />

      {stores.length === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          No stores yet. Run <code className="text-accent-2">npm run ingest:stores</code>.
        </Card>
      ) : (
        groups.map((g) => (
          <section key={g.key}>
            <div className="flex items-baseline gap-3 mb-3">
              <h2 className="text-lg font-semibold">{g.label}</h2>
              <span className="text-xs text-muted">{g.subtitle}</span>
              <span className="ml-auto text-xs text-muted">{g.stores.length} stores</span>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {g.stores.map((s) => (
                <Link key={s.id} href={`/stores/${s.id}`}>
                  <Card className="px-4 py-3 hover:bg-surface-2/50 transition-colors h-full">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {[s.city, s.state].filter(Boolean).join(", ") || regionLabel(s.region)}
                    </div>
                    <div className="text-sm text-accent mt-2 tabular-nums">{s._count.events} events</div>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
