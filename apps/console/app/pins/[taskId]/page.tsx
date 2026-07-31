import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { adminClient, currentConsoleUser } from '../../../lib/supabase';
import { PinEditor } from './PinEditor';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  client_id: string;
  evidence_agent_count: number;
  evidence_visit_count: number;
  suggested_lat: number;
  suggested_lng: number;
  spread_m: number;
  clients: {
    display_name: string;
    address_text: string | null;
    barangay: string | null;
    city: string | null;
    lat: number | null;
    lng: number | null;
    geocode_confidence: string;
  } | null;
}

export default async function PinTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const user = await currentConsoleUser();
  if (user === null) redirect('/login');
  const { taskId } = await params;

  const admin = adminClient();
  const { data } = await admin
    .from('pin_review_tasks')
    .select(
      'id, client_id, evidence_agent_count, evidence_visit_count, ' +
        'suggested_lat, suggested_lng, spread_m, ' +
        'clients(display_name, address_text, barangay, city, lat, lng, geocode_confidence)',
    )
    .eq('id', taskId)
    .maybeSingle();

  const task = data as unknown as TaskRow | null;
  if (task === null) notFound();

  // The arrival points behind this task, so the reviewer sees the evidence
  // rather than trusting the centroid.
  const { data: visitRows } = await admin
    .from('visits')
    .select('arrive_lat, arrive_lng, geofence_miss_reason, arrived_at_server')
    .eq('client_id', task.client_id)
    .eq('is_within_geofence', false)
    .order('arrived_at_server', { ascending: false })
    .limit(20);

  const reports = (visitRows ?? []).map((v) => ({
    lat: v.arrive_lat as number,
    lng: v.arrive_lng as number,
  }));

  const reasons = new Map<string, number>();
  for (const v of visitRows ?? []) {
    const reason = (v.geofence_miss_reason as string | null) ?? 'Walang dahilan';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/pins" className="text-sm text-gray-500 hover:text-gray-900">
        ← Balik sa queue
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-gray-900">
        {task.clients?.display_name ?? 'Client'}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        {[task.clients?.address_text, task.clients?.barangay, task.clients?.city]
          .filter(Boolean)
          .join(', ') || '—'}
      </p>

      <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-gray-500">Ahenteng nag-ulat</dt>
          <dd className="mt-0.5 text-lg font-bold text-gray-900">
            {task.evidence_agent_count}
          </dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-gray-500">Pagkakalapit ng ulat</dt>
          <dd className="mt-0.5 text-lg font-bold text-gray-900">
            ±{Math.round(task.spread_m)}m
          </dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-gray-500">Kasalukuyang geocode</dt>
          <dd className="mt-0.5 text-lg font-bold text-gray-900">
            {task.clients?.geocode_confidence ?? '—'}
          </dd>
        </div>
      </dl>

      {reasons.size > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {[...reasons.entries()].map(([reason, count]) => (
            <li
              key={reason}
              className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-900"
            >
              {reason} × {count}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <PinEditor
          clientId={task.client_id}
          currentLat={task.clients?.lat ?? null}
          currentLng={task.clients?.lng ?? null}
          suggestedLat={task.suggested_lat}
          suggestedLng={task.suggested_lng}
          reports={reports}
        />
      </div>
    </main>
  );
}
