'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { resolveFlagsAction } from '../agent/[agentId]/session/[sessionId]/actions';
import { dateTimePH } from '../../lib/format';

export interface TriageFlag {
  id: string;
  flag_type: string;
  severity: string;
  detail: Record<string, unknown> | null;
  raised_at: string;
  session_id: string | null;
  agent_id: string;
  agents: { full_name: string; employee_no: string } | null;
}

// Grouped by agent, because that is the unit a supervisor acts on: they have
// one conversation with Maricel, not six conversations about six flags.
export function TriageList({
  flags,
  labels,
}: {
  flags: TriageFlag[];
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; employeeNo: string; flags: TriageFlag[] }>();
    for (const flag of flags) {
      const key = flag.agent_id;
      const existing = map.get(key);
      if (existing === undefined) {
        map.set(key, {
          name: flag.agents?.full_name ?? 'Agent',
          employeeNo: flag.agents?.employee_no ?? '',
          flags: [flag],
        });
      } else {
        existing.flags.push(flag);
      }
    }
    // Agents with criticals float up.
    return [...map.entries()].sort((a, b) => {
      const ca = a[1].flags.filter((f) => f.severity === 'critical').length;
      const cb = b[1].flags.filter((f) => f.severity === 'critical').length;
      return cb - ca || b[1].flags.length - a[1].flags.length;
    });
  }, [flags]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectGroup = (groupFlags: TriageFlag[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = groupFlags.every((f) => next.has(f.id));
      for (const f of groupFlags) {
        if (allSelected) next.delete(f.id);
        else next.add(f.id);
      }
      return next;
    });

  const resolve = async () => {
    setBusy(true);
    setError(null);
    const result = await resolveFlagsAction({ flagIds: [...selected], note });
    if (result.status === 'ok') {
      setSelected(new Set());
      setNote('');
      router.refresh();
    } else {
      setError(result.status === 'invalid' ? result.message : 'Walang pahintulot.');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 rounded-2xl border-2 border-emerald-500 bg-white p-4 shadow-lg">
          <p className="text-sm font-semibold text-gray-900">
            Bulk resolve: {selected.size} flag
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Isang tala para sa lahat ng napili (kailangan)"
              className="h-11 flex-1 rounded-xl border border-gray-300 px-3 text-sm"
            />
            <button
              type="button"
              onClick={() => void resolve()}
              disabled={busy}
              className="rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white disabled:bg-gray-300"
            >
              {busy ? 'Sine-save…' : 'I-resolve'}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-xl border border-gray-300 px-4 text-sm font-medium"
            >
              Alisin
            </button>
          </div>
          {error !== null && (
            <p className="mt-2 text-sm text-red-700">{error}</p>
          )}
        </div>
      )}

      {groups.map(([agentId, group]) => (
        <section key={agentId} className="rounded-2xl border border-gray-200 bg-white">
          <header className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
            <div>
              <h2 className="font-semibold text-gray-900">{group.name}</h2>
              <p className="text-xs text-gray-500">{group.employeeNo}</p>
            </div>
            <button
              type="button"
              onClick={() => selectGroup(group.flags)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
            >
              Piliin lahat ({group.flags.length})
            </button>
          </header>
          <ul className="divide-y divide-gray-100">
            {group.flags.map((flag) => (
              <li key={flag.id} className="flex items-start gap-3 px-5 py-3">
                <input
                  type="checkbox"
                  checked={selected.has(flag.id)}
                  onChange={() => toggle(flag.id)}
                  className="mt-1 h-4 w-4"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                        flag.severity === 'critical'
                          ? 'bg-red-600 text-white'
                          : 'bg-amber-200 text-amber-900'
                      }`}
                    >
                      {flag.severity}
                    </span>
                    <span className="font-medium text-gray-900">
                      {labels[flag.flag_type] ?? flag.flag_type}
                    </span>
                    <span className="text-xs text-gray-500">
                      {dateTimePH(flag.raised_at)}
                    </span>
                    {flag.session_id !== null && (
                      <Link
                        href={`/agent/${flag.agent_id}/session/${flag.session_id}`}
                        className="text-xs text-emerald-700 underline"
                      >
                        Buksan ang session
                      </Link>
                    )}
                  </div>
                  {flag.detail !== null && (
                    <p className="mt-1 truncate font-mono text-xs text-gray-500">
                      {JSON.stringify(flag.detail).slice(0, 160)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
