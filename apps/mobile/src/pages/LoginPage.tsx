import { useState, type FormEvent } from 'react';
import { useAuth, type LoginFailure } from '../features/auth/AuthProvider';

const failureCopy: Record<LoginFailure, string> = {
  // Generic on purpose — never reveals whether the employee_no exists.
  invalid_credentials: 'Hindi tama ang employee number o password. Pakisubukan ulit.',
  offline: 'Walang internet. Kailangan ng koneksyon para makapag-login.',
  unavailable: 'May problema sa koneksyon. Pakisubukan ulit mamaya.',
};

// Route component. Layout is bottom-weighted so the form and button sit in
// the thumb zone for one-handed use; all touch targets are >= 56px tall.
export function LoginPage() {
  const { login } = useAuth();
  const [employeeNo, setEmployeeNo] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<LoginFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = employeeNo.trim().length > 0 && password.length > 0 && !busy;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setFailure(null);
    const result = await login(employeeNo, password);
    if (result !== null) {
      setFailure(result);
      setBusy(false);
    }
    // On success the auth phase changes and the router leaves this page.
  };

  return (
    <main className="flex min-h-dvh flex-col bg-white px-6 pb-8 pt-16">
      <div className="flex-1">
        <h1 className="text-3xl font-bold text-emerald-700">Datung Field</h1>
        <p className="mt-2 text-base text-gray-600">
          Mag-login gamit ang employee number mo.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mx-auto w-full max-w-sm space-y-5">
        <div>
          <label
            htmlFor="employee-no"
            className="mb-1.5 block text-sm font-semibold text-gray-800"
          >
            Employee Number
          </label>
          <input
            id="employee-no"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="username"
            placeholder="Hal. DTG-0002"
            value={employeeNo}
            onChange={(e) => setEmployeeNo(e.target.value)}
            className="h-14 w-full rounded-xl border border-gray-300 px-4 text-lg tracking-wide focus:border-emerald-600 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1.5 block text-sm font-semibold text-gray-800"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-14 w-full rounded-xl border border-gray-300 px-4 text-lg focus:border-emerald-600 focus:outline-none"
          />
        </div>

        {failure !== null && (
          <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {failureCopy[failure]}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="h-14 w-full rounded-xl bg-emerald-600 text-lg font-semibold text-white active:bg-emerald-700 disabled:bg-gray-300"
        >
          {busy ? 'Nilo-login…' : 'Mag-login'}
        </button>

        <p className="pt-1 text-center text-sm text-gray-500">
          Nakalimutan ang password? Tawagan ang supervisor mo.
        </p>
      </form>
    </main>
  );
}
