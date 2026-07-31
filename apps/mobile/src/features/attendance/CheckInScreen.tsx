import { useNavigate } from 'react-router-dom';
import { SyncStatusPill } from '../../services/sync/index.ts';
import { useAuth } from '../auth/AuthProvider';
import { useAttendance } from './AttendanceProvider.tsx';

// Home when no session is open. ONE action, sized so nothing competes with
// it: an agent standing in the sun outside a branch at 7am should be able to
// start the day with one thumb without reading anything.
export function CheckInScreen() {
  const { agent, logout } = useAuth();
  const { canCheckIn, loading, banner, dismissBanner } = useAttendance();
  const navigate = useNavigate();

  if (agent === null) return null;
  const firstName = agent.full_name.split(' ')[0] ?? agent.full_name;

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-6 pb-8 pt-12">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Kumusta, {firstName}!</h1>
          <p className="mt-0.5 text-sm text-gray-500">{agent.employee_no}</p>
        </div>
        <SyncStatusPill />
      </header>

      {banner === 'auto_closed_locally' && (
        <div className="mt-5 rounded-2xl bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Awtomatikong isinara ang huling session mo.
          </p>
          <p className="mt-1 text-sm text-amber-900">
            Lumagpas ito ng 16 na oras na bukas, kaya tumigil na ang tracking.
            Walang naitalang check-out — makikita ito ng supervisor mo.
          </p>
          <button
            type="button"
            onClick={dismissBanner}
            className="mt-2 text-sm font-semibold text-amber-900 underline"
          >
            Naintindihan ko
          </button>
        </div>
      )}

      <div className="flex flex-1 flex-col items-center justify-center">
        <button
          type="button"
          disabled={!canCheckIn}
          onClick={() => navigate('/check-in')}
          className="flex aspect-square w-full max-w-[300px] flex-col items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl active:bg-emerald-700 disabled:bg-gray-300"
        >
          <span className="text-3xl font-extrabold tracking-tight">
            MAG-CHECK IN
          </span>
          <span className="mt-2 text-sm font-medium text-emerald-50">
            {loading ? 'Sandali lang…' : 'Pindutin para simulan ang araw'}
          </span>
        </button>
      </div>

      <button
        type="button"
        onClick={() => void logout()}
        className="h-12 w-full rounded-xl text-base font-medium text-gray-500"
      >
        Mag-logout
      </button>
    </main>
  );
}
