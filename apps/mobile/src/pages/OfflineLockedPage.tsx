import { useState } from 'react';
import { OFFLINE_GRACE_HOURS } from '@datung/shared';
import { useAuth } from '../features/auth/AuthProvider';

// Route component. Shown when the app has been offline past the grace window
// — the cached profile is no longer honoured and the agent must reach the
// server again.
export function OfflineLockedPage() {
  const { retryBootstrap, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryBootstrap();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-white px-6 pb-8 pt-16">
      <div className="flex-1">
        <div className="mx-auto max-w-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-3xl">
            🔒
          </div>
          <h1 className="mt-5 text-2xl font-bold text-gray-900">
            Naka-lock ang app.
          </h1>
          <p className="mt-2 text-base text-gray-600">
            Mahigit {OFFLINE_GRACE_HOURS} oras ka nang walang koneksyon.
            Kumonekta sa internet para magpatuloy.
          </p>
        </div>
      </div>
      <div className="mx-auto w-full max-w-sm space-y-3">
        <button
          type="button"
          onClick={() => void onRetry()}
          disabled={busy}
          className="h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white active:bg-emerald-700 disabled:bg-gray-300"
        >
          {busy ? 'Kumokonekta…' : 'Subukan Ulit'}
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="h-14 w-full rounded-xl border border-gray-300 text-lg font-semibold text-gray-700 active:bg-gray-100"
        >
          Mag-logout
        </button>
      </div>
    </main>
  );
}
