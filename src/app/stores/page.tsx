import Link from "next/link";
import { getStores } from "@/lib/queries";
import { Card, PageTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const stores = await getStores();

  return (
    <div>
      <PageTitle title="Stores" subtitle={`${stores.length} stores tracked`} />
      {stores.length === 0 ? (
        <Card className="px-6 py-10 text-center text-muted">
          No stores yet. Run <code className="text-accent-2">npm run ingest:stores</code>.
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {stores.map((s) => (
            <Link key={s.id} href={`/stores/${s.id}`}>
              <Card className="px-4 py-3 hover:bg-surface-2/50 transition-colors h-full">
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted mt-0.5">
                  {[s.city, s.state, s.country].filter(Boolean).join(", ") || "—"}
                </div>
                <div className="text-sm text-accent mt-2 tabular-nums">{s._count.events} events</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
