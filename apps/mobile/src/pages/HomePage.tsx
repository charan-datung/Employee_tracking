import { useAttendance } from '../features/attendance/AttendanceProvider.tsx';
import { ActiveSessionScreen } from '../features/attendance/ActiveSessionScreen.tsx';
import { CheckInScreen } from '../features/attendance/CheckInScreen.tsx';

// Route component. Home is whichever screen the session state demands — the
// agent never chooses between "check in" and "active session", so a second
// session can never be started from the UI.
export function HomePage() {
  const { session, loading } = useAttendance();
  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-gray-50">
        <p className="text-gray-500">Sandali lang…</p>
      </main>
    );
  }
  return session === null ? <CheckInScreen /> : <ActiveSessionScreen />;
}
