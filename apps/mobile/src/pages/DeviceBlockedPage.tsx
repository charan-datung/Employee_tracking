import { useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider';

// Route component. Shown when this phone's ANDROID_ID does not match the
// agent's bound device. There is NO proceed path from here — only supervisor
// approval (by phone, via the request code) or logout.
export function DeviceBlockedPage() {
  const { requestCode, retryDeviceCheck, logout } = useAuth();
  const [busy, setBusy] = useState(false);

  const onRetry = async () => {
    setBusy(true);
    try {
      await retryDeviceCheck();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col bg-white px-6 pb-8 pt-16">
      <div className="flex-1">
        <div className="mx-auto max-w-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-3xl">
            ⚠️
          </div>
          <h1 className="mt-5 text-2xl font-bold text-gray-900">
            Ibang device ito.
          </h1>
          <p className="mt-2 text-base text-gray-600">
            Kailangan ng approval ng supervisor mo bago ka makapag-login sa
            device na ito.
          </p>

          <div className="mt-8 rounded-2xl border-2 border-dashed border-gray-300 bg-gray-50 py-6">
            <p className="text-sm font-medium text-gray-500">Request code</p>
            <p className="mt-1 font-mono text-5xl font-bold tracking-[0.3em] text-gray-900">
              {requestCode ?? '——————'}
            </p>
          </div>

          <p className="mt-4 text-sm text-gray-600">
            Tawagan o i-text ang supervisor mo at basahin ang code na ito.
            Kapag in-approve na niya, pindutin ang{' '}
            <span className="font-semibold">Subukan Ulit</span>.
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
          {busy ? 'Chine-check…' : 'Subukan Ulit'}
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
