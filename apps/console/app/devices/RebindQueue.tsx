'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveRebindAction, rejectRebindAction } from './actions';

export interface RebindRequest {
  flagId: string;
  agentId: string;
  agentName: string;
  employeeNo: string;
  requestCode: string;
  raisedAt: string;
  newDevice: Record<string, unknown> | null;
  oldDevice: Record<string, unknown> | null;
  history: { label: string; severity: string; at: string }[];
}

function DeviceCard({
  title,
  device,
  tone,
}: {
  title: string;
  device: Record<string, unknown> | null;
  tone: 'old' | 'new';
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        tone === 'new' ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50'
      }`}
    >
      <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
        {title}
      </p>
      {device === null ? (
        <p className="mt-1 text-sm text-gray-400">Wala</p>
      ) : (
        <dl className="mt-1 space-y-0.5 text-xs text-gray-700">
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">Model</dt>
            <dd className="text-right font-medium">
              {String(device['manufacturer'] ?? '')} {String(device['device_model'] ?? '—')}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">Android</dt>
            <dd>{String(device['os_version'] ?? '—')}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">App</dt>
            <dd>{String(device['app_version'] ?? '—')}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-gray-500">ANDROID_ID</dt>
            <dd className="font-mono">{String(device['android_id'] ?? '—')}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export function RebindQueue({ requests }: { requests: RebindRequest[] }) {
  const router = useRouter();
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  if (requests.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-gray-300 p-10 text-center text-gray-500">
        Walang naghihintay na rebind request. 🎉
      </p>
    );
  }

  const approve = async (req: RebindRequest) => {
    setBusy(req.flagId);
    setMessage(null);
    // The supervisor types the code the agent read out — the console never
    // pre-fills it. Approving without hearing the code from the agent is
    // exactly the failure this control exists to prevent.
    const result = await approveRebindAction({
      requestCode: (codes[req.flagId] ?? '').trim().toUpperCase(),
    });
    setBusy(null);
    if (result.status === 'ok') {
      setMessage({ id: req.flagId, text: 'Na-approve. Puwede nang mag-login.', ok: true });
      router.refresh();
    } else if (result.status === 'invalid_code') {
      setMessage({ id: req.flagId, text: 'Mali ang code, expired na, o hindi sa tree mo.', ok: false });
    } else {
      setMessage({ id: req.flagId, text: 'Walang pahintulot.', ok: false });
    }
  };

  const reject = async (req: RebindRequest) => {
    setBusy(req.flagId);
    setMessage(null);
    const result = await rejectRebindAction({
      flagId: req.flagId,
      reason: reasons[req.flagId] ?? '',
    });
    setBusy(null);
    if (result.status === 'ok') {
      setRejecting(null);
      router.refresh();
    } else {
      setMessage({
        id: req.flagId,
        text: result.status === 'invalid' ? result.message : 'Walang pahintulot.',
        ok: false,
      });
    }
  };

  return (
    <ul className="space-y-4">
      {requests.map((req) => (
        <li key={req.flagId} className="rounded-2xl border border-gray-200 bg-white p-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">{req.agentName}</h2>
              <p className="text-sm text-gray-500">
                {req.employeeNo} · hiniling {req.raisedAt}
              </p>
            </div>
            <div className="rounded-xl bg-gray-900 px-4 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">
                Inaasahang code
              </p>
              <p className="font-mono text-xl font-bold tracking-[0.2em] text-white">
                {req.requestCode || '——————'}
              </p>
            </div>
          </header>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DeviceCard title="Dating device" device={req.oldDevice} tone="old" />
            <DeviceCard title="Bagong device" device={req.newDevice} tone="new" />
          </div>

          {req.history.length > 0 && (
            <details className="mt-3 rounded-xl bg-gray-50 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-gray-600">
                Flag history ng ahente ({req.history.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {req.history.map((h, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs">
                    <span
                      className={`rounded px-1.5 py-0.5 font-bold ${
                        h.severity === 'critical'
                          ? 'bg-red-600 text-white'
                          : 'bg-amber-200 text-amber-900'
                      }`}
                    >
                      {h.severity}
                    </span>
                    <span className="text-gray-700">{h.label}</span>
                    <span className="ml-auto text-gray-400">{h.at}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={codes[req.flagId] ?? ''}
              onChange={(e) =>
                setCodes((c) => ({ ...c, [req.flagId]: e.target.value }))
              }
              placeholder="Code mula sa ahente"
              maxLength={6}
              className="h-11 w-44 rounded-xl border border-gray-300 px-3 font-mono uppercase tracking-widest"
            />
            <button
              type="button"
              onClick={() => void approve(req)}
              disabled={busy === req.flagId}
              className="h-11 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-gray-300"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => setRejecting(rejecting === req.flagId ? null : req.flagId)}
              className="h-11 rounded-xl border border-red-300 px-4 text-sm font-semibold text-red-700 hover:bg-red-50"
            >
              Reject
            </button>
          </div>

          {rejecting === req.flagId && (
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={reasons[req.flagId] ?? ''}
                onChange={(e) =>
                  setReasons((r) => ({ ...r, [req.flagId]: e.target.value }))
                }
                placeholder="Bakit hindi in-approve? (kailangan)"
                className="h-11 flex-1 rounded-xl border border-gray-300 px-3 text-sm"
              />
              <button
                type="button"
                onClick={() => void reject(req)}
                disabled={busy === req.flagId}
                className="h-11 rounded-xl bg-red-600 px-5 text-sm font-semibold text-white disabled:bg-gray-300"
              >
                Kumpirmahin
              </button>
            </div>
          )}

          {message !== null && message.id === req.flagId && (
            <p
              className={`mt-3 rounded-xl px-4 py-2 text-sm ${
                message.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
              }`}
            >
              {message.text}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
