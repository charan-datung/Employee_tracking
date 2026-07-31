import Link from 'next/link';
import { redirect } from 'next/navigation';
import { adminClient, currentConsoleUser } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

interface TaskRow {
  id: string;
  client_id: string;
  evidence_agent_count: number;
  evidence_visit_count: number;
  suggested_lat: number;
  suggested_lng: number;
  spread_m: number;
  created_at: string;
  clients: { display_name: string; barangay: string | null; city: string | null } | null;
}

// The pin review queue. Tasks are raised automatically when three or more
// agents independently log a geofence miss for the same client from
// consistent positions — the pin is wrong, not the agents.
export default async function PinsPage() {
  const user = await currentConsoleUser();
  if (user === null) redirect('/login');

  const { data } = await adminClient()
    .from('pin_review_tasks')
    .select(
      'id, client_id, evidence_agent_count, evidence_visit_count, ' +
        'suggested_lat, suggested_lng, spread_m, created_at, ' +
        'clients(display_name, barangay, city)',
    )
    .eq('status', 'open')
    .order('created_at', { ascending: true });

  const tasks = (data ?? []) as unknown as TaskRow[];

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pin review</h1>
          <p className="mt-1 text-sm text-gray-500">
            Mga client na malamang maling pin ang naka-tala sa mapa.
          </p>
        </div>
        <span className="text-sm text-gray-500">{user.employeeNo}</span>
      </header>

      {tasks.length === 0 ? (
        <p className="mt-10 rounded-2xl border border-dashed border-gray-300 p-10 text-center text-gray-500">
          Walang naghihintay na pin review. 🎉
        </p>
      ) : (
        <ul className="mt-8 space-y-3">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                href={`/pins/${task.id}`}
                className="block rounded-2xl border border-gray-200 p-5 transition hover:border-gray-400"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-base font-semibold text-gray-900">
                      {task.clients?.display_name ?? 'Client'}
                    </p>
                    <p className="mt-0.5 text-sm text-gray-500">
                      {[task.clients?.barangay, task.clients?.city]
                        .filter(Boolean)
                        .join(', ') || '—'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <p className="font-semibold text-amber-700">
                      {task.evidence_agent_count} ahente
                    </p>
                    <p className="text-gray-500">
                      {task.evidence_visit_count} ulat · ±
                      {Math.round(task.spread_m)}m
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
