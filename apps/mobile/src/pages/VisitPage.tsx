import { useNavigate } from 'react-router-dom';
import { useAttendance } from '../features/attendance/AttendanceProvider.tsx';

// Route component. Visit logging itself is the next change; this screen
// exists so the primary action on the active-session screen has an honest
// destination and so the permission gate is enforced on this route too, not
// only on the button.
export default function VisitPage() {
  const { canLogVisit } = useAttendance();
  const navigate = useNavigate();

  return (
    <main className="flex min-h-dvh flex-col bg-gray-50 px-6 pb-8 pt-12">
      <h1 className="text-xl font-bold text-gray-900">Maglog ng visit</h1>
      <div className="flex flex-1 items-center justify-center">
        <p className="max-w-xs text-center text-gray-500">
          {canLogVisit
            ? 'Darating dito ang visit logging sa susunod na update.'
            : 'Hindi ka makakapag-log ng visit habang naka-off ang location permission.'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => navigate('/', { replace: true })}
        className="h-14 w-full rounded-xl border border-gray-300 bg-white text-lg font-semibold text-gray-700"
      >
        Bumalik
      </button>
    </main>
  );
}
