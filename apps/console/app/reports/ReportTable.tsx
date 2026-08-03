'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { datePH, timePH, OUTCOME_LABELS } from '../../lib/format';

export interface ReportRow {
  sessionId: string;
  agentId: string;
  agentName: string;
  employeeNo: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  visitCount: number;
  outcomeMix: Record<string, number>;
  integrityScore: number | null;
  criticalFlags: number;
  warnFlags: number;
}

function csvEscape(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ReportTable({
  rows,
  showDuration,
}: {
  rows: ReportRow[];
  // See lib/reportFlags.ts — off unless NEXT_PUBLIC_SHOW_DURATION === 'true',
  // for labor-law reasons, not cosmetic ones.
  showDuration: boolean;
}) {
  const csv = useMemo(() => {
    const header = [
      'date', 'employee_no', 'agent', 'status', 'check_in', 'check_out',
      'visits', 'outcome_mix', 'integrity_score', 'critical_flags', 'warn_flags',
      ...(showDuration ? ['elapsed_minutes'] : []),
    ];
    const lines = rows.map((r) => {
      const mix = Object.entries(r.outcomeMix)
        .map(([k, v]) => `${OUTCOME_LABELS[k] ?? k}:${v}`)
        .join(' ');
      const base = [
        datePH(r.openedAt), r.employeeNo, r.agentName, r.status,
        timePH(r.openedAt), timePH(r.closedAt), r.visitCount, mix,
        r.integrityScore, r.criticalFlags, r.warnFlags,
      ];
      if (showDuration) {
        base.push(
          r.closedAt === null
            ? ''
            : Math.round(
                (new Date(r.closedAt).getTime() - new Date(r.openedAt).getTime()) /
                  60000,
              ),
        );
      }
      return base.map(csvEscape).join(',');
    });
    return [header.join(','), ...lines].join('\n');
  }, [rows, showDuration]);

  const download = () => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `datung-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">{rows.length} row</p>
        <button
          type="button"
          onClick={download}
          className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-gray-50"
        >
          I-export ang CSV
        </button>
      </div>

      {!showDuration && (
        <p className="rounded-xl bg-gray-100 px-4 py-2 text-xs text-gray-600">
          Walang hours/duration column. Sinadya ito — tingnan ang
          <code className="mx-1 rounded bg-white px-1">lib/reportFlags.ts</code>
          bago baguhin.
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">Petsa</th>
              <th className="px-4 py-3">Agent</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">In</th>
              <th className="px-4 py-3">Out</th>
              <th className="px-4 py-3 text-right">Visits</th>
              <th className="px-4 py-3">Outcome mix</th>
              <th className="px-4 py-3 text-right">Score</th>
              <th className="px-4 py-3 text-right">Flags</th>
              {showDuration && <th className="px-4 py-3 text-right">Elapsed</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.sessionId}>
                <td className="px-4 py-3 text-gray-600">{datePH(r.openedAt)}</td>
                <td className="px-4 py-3">
                  <Link
                    href={`/agent/${r.agentId}/session/${r.sessionId}`}
                    className="font-medium text-gray-900 hover:text-emerald-700 hover:underline"
                  >
                    {r.agentName}
                  </Link>
                  <span className="block text-xs text-gray-500">{r.employeeNo}</span>
                </td>
                <td className="px-4 py-3 text-gray-600">{r.status}</td>
                <td className="px-4 py-3 text-gray-600">{timePH(r.openedAt)}</td>
                <td className="px-4 py-3 text-gray-600">{timePH(r.closedAt)}</td>
                <td className="px-4 py-3 text-right text-gray-700">{r.visitCount}</td>
                <td className="px-4 py-3 text-xs text-gray-600">
                  {Object.entries(r.outcomeMix)
                    .map(([k, v]) => `${OUTCOME_LABELS[k] ?? k} ${v}`)
                    .join(' · ') || '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.integrityScore === null ? (
                    <span className="text-gray-400">—</span>
                  ) : (
                    <span
                      className={
                        r.integrityScore < 50
                          ? 'font-semibold text-red-700'
                          : r.integrityScore < 85
                            ? 'font-semibold text-amber-700'
                            : 'text-emerald-700'
                      }
                    >
                      {r.integrityScore}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-xs">
                  {r.criticalFlags > 0 && (
                    <span className="mr-1 rounded bg-red-600 px-1.5 py-0.5 font-bold text-white">
                      {r.criticalFlags}
                    </span>
                  )}
                  {r.warnFlags > 0 && (
                    <span className="rounded bg-amber-200 px-1.5 py-0.5 font-semibold text-amber-900">
                      {r.warnFlags}
                    </span>
                  )}
                  {r.criticalFlags === 0 && r.warnFlags === 0 && (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                {showDuration && (
                  <td className="px-4 py-3 text-right text-gray-700">
                    {r.closedAt === null
                      ? '—'
                      : `${Math.round(
                          (new Date(r.closedAt).getTime() -
                            new Date(r.openedAt).getTime()) /
                            60000,
                        )}m`}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
