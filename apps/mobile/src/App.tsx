import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, type AuthPhase } from './features/auth/AuthProvider';
import { useSyncStatus } from './services/sync/index.ts';

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

// Blocking storage-pressure warning (sync rule 7): the outbox is over its
// limits and unsynced evidence is at risk. Never dismissible from within —
// it clears only when sync drains the backlog. Unsynced data is NEVER purged.
function StoragePressureOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl">
          ⚠️
        </div>
        <h2 className="mt-4 text-xl font-bold text-gray-900">
          Puno na ang local storage.
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          Maraming record ang hindi pa na-sync. Kumonekta sa internet at
          hintaying maka-sync. <span className="font-semibold">Huwag
          i-uninstall o i-clear ang app</span> — mabubura ang mga hindi pa
          naipapadalang record. Tawagan ang supervisor mo kung hindi ito
          nawawala.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const { phase } = useAuth();
  const { storagePressure } = useSyncStatus();
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
  return (
    <>
      <Outlet />
      {storagePressure && <StoragePressureOverlay />}
    </>
  );
}
