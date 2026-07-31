import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type AuthPhase } from './features/auth/AuthProvider';

// Each auth phase has exactly one home route; the shell keeps the URL and the
// phase in lock-step so no gate screen can be escaped by navigation. The
// gates (device block, consent, offline lock) have no other exit paths.
const phaseRoute: Record<Exclude<AuthPhase, 'booting'>, string> = {
  signed_out: '/login',
  device_blocked: '/device-blocked',
  consent_required: '/consent',
  offline_locked: '/locked',
  ready: '/',
};

function Splash() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-white">
      <p className="text-xl font-bold text-emerald-700">Datung Field</p>
    </main>
  );
}

export function App() {
  const { phase } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (phase === 'booting') return;
    const target = phaseRoute[phase];
    if (location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [phase, location.pathname, navigate]);

  if (phase === 'booting') return <Splash />;
  return <Outlet />;
}
