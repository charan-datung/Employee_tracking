import { useAuth } from '../features/auth/AuthProvider';
import { SyncStatusPill } from '../services/sync/index.ts';

const roleLabel: Record<string, string> = {
  sales_agent: 'Sales Agent',
  collector: 'Collector',
  field_supervisor: 'Field Supervisor',
};

// Route component. Placeholder shell — attendance check-in arrives in a later
// change; auth/binding/consent are the only live features here.
export function HomePage() {
  const { agent, isOffline, logout } = useAuth();
  if (agent === null) return null;

  const firstName = agent.full_name.split(' ')[0] ?? agent.full_name;

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-6 pb-8 pt-14">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Kumusta, {firstName}!
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {agent.employee_no} · {roleLabel[agent.role] ?? agent.role}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <SyncStatusPill />
          {isOffline && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              Offline
            </span>
          )}
        </div>
      </header>

      <div className="mt-8 flex-1">
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center text-gray-500">
          Darating dito ang check-in sa susunod na update.
        </div>
      </div>

      <button
        type="button"
        onClick={() => void logout()}
        className="h-14 w-full rounded-xl border border-gray-300 bg-white text-lg font-semibold text-gray-700 active:bg-gray-100"
      >
        Mag-logout
      </button>
    </main>
  );
}
