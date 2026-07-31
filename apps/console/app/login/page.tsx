'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

// Console sign-in. Supervisors use the same Supabase account as the mobile
// app (synthetic <employee_no>@datung.internal address), so there is one
// identity per person across both surfaces. Access is decided server-side:
// only an active field_supervisor gets past currentConsoleUser().
export default function LoginPage() {
  const router = useRouter();
  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(false);
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    );
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: `${employeeNo.trim().toLowerCase()}@datung.internal`,
      password,
    });
    if (signInError !== null) {
      // Generic on purpose — never reveals whether an employee_no exists.
      setError(true);
      setBusy(false);
      return;
    }
    router.push('/pins');
    router.refresh();
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-50 px-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm"
      >
        <h1 className="text-xl font-bold text-emerald-700">Datung Field Console</h1>
        <p className="mt-1 text-sm text-gray-500">Para sa field supervisors.</p>

        <label className="mt-6 block">
          <span className="text-sm font-medium text-gray-700">Employee Number</span>
          <input
            type="text"
            autoCapitalize="characters"
            autoComplete="username"
            value={employeeNo}
            onChange={(e) => setEmployeeNo(e.target.value)}
            className="mt-1 h-11 w-full rounded-xl border border-gray-300 px-3"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-gray-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 h-11 w-full rounded-xl border border-gray-300 px-3"
          />
        </label>

        {error && (
          <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            Hindi tama ang employee number o password.
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 h-12 w-full rounded-xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700 disabled:bg-gray-300"
        >
          {busy ? 'Nilo-login…' : 'Mag-login'}
        </button>
      </form>
    </main>
  );
}
