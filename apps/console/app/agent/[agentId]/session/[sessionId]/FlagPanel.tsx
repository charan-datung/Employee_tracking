'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { resolveFlagsAction, voidSessionAction } from './actions';
import { dateTimePH, FLAG_LABELS } from '../../../../../lib/format';

export interface FlagRow {
  id: string;
  flag_type: string;
  severity: string;
  detail: Record<string, unknown> | null;
  raised_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

// Renders detail jsonb as readable rows instead of a blob. Nested objects and
// arrays (the ping_gap `gaps` array, for instance) get their own indented
// block — a supervisor should never have to read raw JSON to find out whether
// a gap was a dead battery.
function DetailValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-gray-400">—</span>;
  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {value.map((item, i) => (
          <div key={i} className="rounded-lg bg-white p-2 ring-1 ring-gray-200">
            <DetailValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === 'object') {
    return (
      <dl className="space-y-0.5">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="flex gap-2 text-xs">
            <dt className="shrink-0 font-medium text-gray-500">
              {k.replace(/_/g, ' ')}
            </dt>
            <dd className="min-w-0 text-gray-800">
              <DetailValue value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="break-words">{String(value)}</span>;
}

export function FlagPanel({
  flags,
  sessionId,
  sessionStatus,
}: {
  flags: FlagRow[];
  sessionId: string;
  sessionStatus: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  const open = flags.filter((f) => f.resolved_at === null);
  const resolved = flags.filter((f) => f.resolved_at !== null);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const resolve = async () => {
    setBusy(true);
    setError(null);
    const result = await resolveFlagsAction({
      flagIds: [...selected],
      note,
    });
    if (result.status === 'ok') {
      setSelected(new Set());
      setNote('');
      router.refresh();
    } else {
      setError(
        result.status === 'invalid' ? result.message : 'Walang pahintulot.',
      );
    }
    setBusy(false);
  };

  const doVoid = async () => {
    setBusy(true);
    setError(null);
    const result = await voidSessionAction({ sessionId, reason: voidReason });
    if (result.status === 'ok') {
      setVoiding(false);
      router.refresh();
    } else {
      setError(
        result.status === 'invalid' ? result.message : 'Walang pahintulot.',
      );
    }
    setBusy(false);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-900">
          Integrity flags{' '}
          <span className="text-sm font-normal text-gray-500">
            ({open.length} bukas)
          </span>
        </h2>
        {sessionStatus !== 'voided' && (
          <button
            type="button"
            onClick={() => setVoiding((v) => !v)}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"
          >
            I-void ang session
          </button>
        )}
      </div>

      {voiding && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">
            Ang pag-void ay hindi na mababawi. Ilagay kung bakit.
          </p>
          <textarea
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            rows={2}
            placeholder="Hal. Kinumpirma sa agent na hindi siya pumasok; naiwan ang phone sa kasama."
            className="mt-2 w-full rounded-xl border border-red-300 p-2 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void doVoid()}
              disabled={busy}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-300"
            >
              I-void
            </button>
            <button
              type="button"
              onClick={() => setVoiding(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium"
            >
              Kanselahin
            </button>
          </div>
        </div>
      )}

      {open.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          Walang bukas na flag sa session na ito.
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {open.map((flag) => (
              <li
                key={flag.id}
                className={`rounded-2xl border p-4 ${
                  flag.severity === 'critical'
                    ? 'border-red-300 bg-red-50'
                    : 'border-amber-200 bg-amber-50'
                }`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(flag.id)}
                    onChange={() => toggle(flag.id)}
                    className="mt-1 h-4 w-4"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                          flag.severity === 'critical'
                            ? 'bg-red-600 text-white'
                            : 'bg-amber-200 text-amber-900'
                        }`}
                      >
                        {flag.severity}
                      </span>
                      <span className="font-semibold text-gray-900">
                        {FLAG_LABELS[flag.flag_type] ?? flag.flag_type}
                      </span>
                      <span className="ml-auto text-xs text-gray-500">
                        {dateTimePH(flag.raised_at)}
                      </span>
                    </div>
                    {flag.detail !== null && (
                      <div className="mt-2 rounded-lg bg-white/70 p-2">
                        <DetailValue value={flag.detail} />
                      </div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>

          {selected.size > 0 && (
            <div className="rounded-2xl border border-gray-300 bg-white p-4">
              <p className="text-sm font-semibold text-gray-900">
                I-resolve ang {selected.size} flag
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Kailangan ng tala. Hal. Nakausap si Maricel — namatayan ng baterya, may power bank na siya."
                className="mt-2 w-full rounded-xl border border-gray-300 p-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void resolve()}
                disabled={busy}
                className="mt-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-gray-300"
              >
                {busy ? 'Sine-save…' : 'I-resolve'}
              </button>
            </div>
          )}
        </>
      )}

      {error !== null && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}

      {resolved.length > 0 && (
        <details className="rounded-2xl border border-gray-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-medium text-gray-600">
            {resolved.length} na-resolve na
          </summary>
          <ul className="mt-3 space-y-2">
            {resolved.map((flag) => (
              <li key={flag.id} className="text-sm text-gray-600">
                <span className="font-medium">
                  {FLAG_LABELS[flag.flag_type] ?? flag.flag_type}
                </span>
                {flag.resolution_note !== null && (
                  <span className="text-gray-500"> — {flag.resolution_note}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
