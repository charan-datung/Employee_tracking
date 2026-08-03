'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@supabase/ssr';
import { ageLabel, ageMinutes, timePH } from '../lib/format';

// The morning board.
//
// THE NUMBER THAT MATTERS is "not checked in by 9:00 AM". It renders red, it
// is counted in a banner above the table, and its rows sort to the top. A
// supervisor opening this at 9:05 should not have to read a table to learn
// who is missing — the count is the headline.

export const CHECK_IN_DEADLINE_HOUR = 9; // 09:00 Asia/Manila
const STALE_PING_MINUTES = 45;

export interface BoardRow {
  agent_id: string;
  employee_no: string;
  full_name: string;
  role: string;
  branch_name: string | null;
  session_id: string | null;
  session_status: string | null;
  opened_at_server: string | null;
  closed_at_server: string | null;
  integrity_score: number | null;
  visit_count: number;
  last_ping_at: string | null;
  open_critical_flags: number;
  open_warn_flags: number;
}

type Status = 'checked_in' | 'checked_out' | 'not_checked_in';

function statusOf(row: BoardRow): Status {
  if (row.session_status === 'open') return 'checked_in';
  if (row.session_id !== null) return 'checked_out';
  return 'not_checked_in';
}

// Is it past 09:00 in Manila right now?
function pastDeadline(nowMs: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(nowMs)),
  );
  return hour >= CHECK_IN_DEADLINE_HOUR;
}

// "Needs attention" ordering, exactly as specified: open criticals first,
// then stale pings, then not-checked-in. Everything else falls below.
export function attentionRank(row: BoardRow, nowMs: number): number {
  if (row.open_critical_flags > 0) return 0;
  const status = statusOf(row);
  const pingAge = ageMinutes(row.last_ping_at, nowMs);
  if (status === 'checked_in' && (pingAge === null || pingAge > STALE_PING_MINUTES)) {
    return 1;
  }
  if (status === 'not_checked_in' && pastDeadline(nowMs)) return 2;
  if (status === 'not_checked_in') return 3;
  if (row.open_warn_flags > 0) return 4;
  return 5;
}

export function BoardTable({ initialRows }: { initialRows: BoardRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [live, setLive] = useState(false);

  // Ages are relative; without a tick the board silently goes stale on a
  // screen someone leaves open all morning.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    );
    const { data } = await supabase.rpc('supervisor_board');
    if (Array.isArray(data)) setRows(data as BoardRow[]);
  }, []);

  // Realtime on attendance_sessions and integrity_flags. RLS applies to
  // replication too, so a supervisor is only woken by changes they could
  // have read anyway. Each event re-runs the board RPC rather than patching
  // rows locally — the RPC is the single definition of what the board means.
  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    );
    const channel = supabase
      .channel('board')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_sessions' },
        () => void refresh())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'integrity_flags' },
        () => void refresh())
      .subscribe((status) => setLive(status === 'SUBSCRIBED'));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const rank = attentionRank(a, nowMs) - attentionRank(b, nowMs);
        if (rank !== 0) return rank;
        return a.full_name.localeCompare(b.full_name);
      }),
    [rows, nowMs],
  );

  const missing = sorted.filter(
    (r) => statusOf(r) === 'not_checked_in' && pastDeadline(nowMs),
  );

  return (
    <div className="space-y-5">
      {/* The headline number. */}
      {missing.length > 0 ? (
        <div className="rounded-2xl border-2 border-red-600 bg-red-50 p-6">
          <p className="text-5xl font-extrabold text-red-700">{missing.length}</p>
          <p className="mt-1 text-lg font-bold text-red-900">
            hindi pa naka-check in — lagpas na alas-9
          </p>
          <p className="mt-2 text-sm text-red-800">
            {missing.map((r) => r.full_name).join(' · ')}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-5">
          <p className="text-lg font-bold text-emerald-800">
            {pastDeadline(nowMs)
              ? 'Lahat naka-check in. ✓'
              : 'Bago pa mag-alas-9 — hindi pa due ang check-in.'}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-700">
          {sorted.length} ahente
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <span
            className={`inline-block h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-gray-300'}`}
          />
          {live ? 'Live' : 'Kumokonekta…'}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">Agent</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Check-in</th>
              <th className="px-4 py-3 text-right">Visits</th>
              <th className="px-4 py-3 text-right">Last ping</th>
              <th className="px-4 py-3 text-right">Integrity</th>
              <th className="px-4 py-3">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((row) => {
              const status = statusOf(row);
              const pingAge = ageMinutes(row.last_ping_at, nowMs);
              const stalePing =
                status === 'checked_in' &&
                (pingAge === null || pingAge > STALE_PING_MINUTES);
              const late = status === 'not_checked_in' && pastDeadline(nowMs);
              return (
                <tr key={row.agent_id} className={late ? 'bg-red-50' : undefined}>
                  <td className="px-4 py-3">
                    {row.session_id !== null ? (
                      <Link
                        href={`/agent/${row.agent_id}/session/${row.session_id}`}
                        className="font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                      >
                        {row.full_name}
                      </Link>
                    ) : (
                      <span className="font-medium text-gray-900">{row.full_name}</span>
                    )}
                    <span className="block text-xs text-gray-500">
                      {row.employee_no}
                      {row.branch_name !== null ? ` · ${row.branch_name}` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {status === 'checked_in' && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                        Naka-check in
                      </span>
                    )}
                    {status === 'checked_out' && (
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
                        Naka-check out
                      </span>
                    )}
                    {status === 'not_checked_in' && (
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                          late
                            ? 'bg-red-600 text-white'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        Hindi pa naka-check in
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {timePH(row.opened_at_server)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {row.session_id === null ? '—' : row.visit_count}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${stalePing ? 'font-bold text-red-700' : 'text-gray-700'}`}
                  >
                    {status === 'checked_in' ? ageLabel(row.last_ping_at, nowMs) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.integrity_score === null ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <span
                        className={`font-semibold ${
                          row.integrity_score < 50
                            ? 'text-red-700'
                            : row.integrity_score < 85
                              ? 'text-amber-700'
                              : 'text-emerald-700'
                        }`}
                      >
                        {row.integrity_score}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex gap-1.5">
                      {row.open_critical_flags > 0 && (
                        <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                          {row.open_critical_flags} critical
                        </span>
                      )}
                      {row.open_warn_flags > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                          {row.open_warn_flags} warn
                        </span>
                      )}
                      {row.open_critical_flags === 0 && row.open_warn_flags === 0 && (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
