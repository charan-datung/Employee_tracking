'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { upsertBranchAction, type AdminResult } from '../actions';

export interface AdminBranchRow {
  id: string;
  name: string;
  code: string;
  address: string | null;
  lat: number;
  lng: number;
  geofenceRadiusM: number;
  isActive: boolean;
}

export function BranchesAdmin({ branches }: { branches: AdminBranchRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminResult | null>(null);

  const submit = async (form: HTMLFormElement, branch: AdminBranchRow | null) => {
    const fd = new FormData(form);
    const str = (k: string): string => String(fd.get(k) ?? '').trim();
    setBusy(true);
    setResult(null);
    const r = await upsertBranchAction({
      branchId: branch?.id ?? null,
      name: str('name'),
      code: str('code'),
      address: str('address').length > 0 ? str('address') : null,
      lat: Number(str('lat')),
      lng: Number(str('lng')),
      geofenceRadiusM: Number(str('geofenceRadiusM')),
      isActive: fd.get('isActive') === 'on',
    });
    setResult(r);
    if (r.status === 'ok') {
      setEditing(null);
      setCreating(false);
      router.refresh();
    }
    setBusy(false);
  };

  const fields = (branch: AdminBranchRow | null) => (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Pangalan</span>
        <input name="name" required defaultValue={branch?.name ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Code</span>
        <input name="code" required maxLength={10} defaultValue={branch?.code ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm uppercase" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Address</span>
        <input name="address" defaultValue={branch?.address ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Latitude</span>
        <input name="lat" required type="number" step="any" defaultValue={branch?.lat ?? ''}
          placeholder="14.4512"
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Longitude</span>
        <input name="lng" required type="number" step="any" defaultValue={branch?.lng ?? ''}
          placeholder="120.9822"
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Geofence radius (m)</span>
        <input name="geofenceRadiusM" required type="number" min={20} max={2000}
          defaultValue={branch?.geofenceRadiusM ?? 150}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm" />
      </label>
      <label className="flex items-center gap-2 pt-5">
        <input name="isActive" type="checkbox" defaultChecked={branch?.isActive ?? true}
          className="h-4 w-4" />
        <span className="text-sm text-gray-700">Aktibo</span>
      </label>
    </div>
  );

  return (
    <div className="space-y-4">
      {result !== null && (
        <p className={`rounded-xl px-4 py-3 text-sm ${
          result.status === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
        }`}>{result.message}</p>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={() => { setCreating((c) => !c); setEditing(null); }}
          className="rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white">
          {creating ? 'Kanselahin' : '+ Bagong branch'}
        </button>
      </div>

      {creating && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget, null); }}
          className="rounded-2xl border border-gray-300 bg-white p-5">
          {fields(null)}
          <button type="submit" disabled={busy}
            className="mt-4 h-11 rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white disabled:bg-gray-300">
            Gumawa ng branch
          </button>
        </form>
      )}

      <ul className="space-y-3">
        {branches.map((branch) => (
          <li key={branch.id} className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-gray-900">
                  {branch.name}{' '}
                  <span className="text-sm font-normal text-gray-500">({branch.code})</span>
                  {!branch.isActive && (
                    <span className="ml-2 rounded bg-gray-200 px-2 py-0.5 text-xs">hindi aktibo</span>
                  )}
                </h2>
                <p className="mt-0.5 text-sm text-gray-500">{branch.address ?? '—'}</p>
                <p className="mt-1 font-mono text-xs text-gray-500">
                  {branch.lat.toFixed(6)}, {branch.lng.toFixed(6)} · {branch.geofenceRadiusM}m
                </p>
              </div>
              <button type="button"
                onClick={() => { setEditing(editing === branch.id ? null : branch.id); setCreating(false); }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
                I-edit
              </button>
            </div>
            {editing === branch.id && (
              <form onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget, branch); }}
                className="mt-4 border-t border-gray-100 pt-4">
                {fields(branch)}
                <button type="submit" disabled={busy}
                  className="mt-4 h-10 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white disabled:bg-gray-300">
                  I-save
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
