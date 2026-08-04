import { requireAdmin, userClient } from '../../../lib/supabase';
import { BranchesAdmin, type AdminBranchRow } from './BranchesAdmin';

export const dynamic = 'force-dynamic';

export default async function BranchesAdminPage() {
  await requireAdmin();
  const supabase = await userClient();

  const { data } = await supabase
    .from('branches')
    .select('id, name, code, address, lat, lng, geofence_radius_m, is_active')
    .order('code');

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const branches: AdminBranchRow[] = rows.map((b) => ({
    id: String(b['id']),
    name: String(b['name']),
    code: String(b['code']),
    address: (b['address'] as string | null) ?? null,
    lat: Number(b['lat']),
    lng: Number(b['lng']),
    geofenceRadiusM: Number(b['geofence_radius_m']),
    isActive: Boolean(b['is_active']),
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Mga branch</h1>
        <p className="mt-1 text-sm text-gray-500">
          Ang coordinates dito ang ginagamit sa check-in distance. Kung mali
          ang pin ng branch, magmumukhang malayo lahat ng check-in.
        </p>
      </header>
      <div className="mt-6">
        <BranchesAdmin branches={branches} />
      </div>
    </main>
  );
}
