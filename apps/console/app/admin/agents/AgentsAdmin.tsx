'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createAgentAction,
  resetPasswordAction,
  updateAgentAction,
  type AdminResult,
} from '../actions';

export interface AdminAgent {
  id: string;
  authUserId: string | null;
  employeeNo: string;
  fullName: string;
  mobileNo: string | null;
  role: string;
  branchId: string;
  supervisorAgentId: string | null;
  employmentStatus: string;
}

export interface AdminBranch { id: string; name: string; code: string }

const ROLE_LABELS: Record<string, string> = {
  sales_agent: 'Sales Agent',
  collector: 'Collector',
  field_supervisor: 'Field Supervisor',
  admin: 'Admin',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Aktibo',
  suspended: 'Suspendido',
  separated: 'Hiwalay na',
};

// Shows a temporary password ONCE, prominently, with instructions. It is
// never stored anywhere we can read it back — if the admin closes this
// without writing it down, the only remedy is another reset. Saying so on
// screen is cheaper than a support call.
function TempPasswordBanner({
  password,
  onDismiss,
}: {
  password: string;
  onDismiss(): void;
}) {
  return (
    <div className="rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-5">
      <p className="text-sm font-bold text-emerald-900">
        Pansamantalang password — isulat mo ito ngayon
      </p>
      <p className="mt-2 select-all font-mono text-3xl font-bold tracking-wider text-emerald-950">
        {password}
      </p>
      <p className="mt-2 text-sm text-emerald-900">
        Hindi na ito maipapakita ulit. Ibigay sa ahente sa telepono, at
        pabaguhin nila agad pagkatapos mag-login.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
      >
        Naisulat ko na
      </button>
    </div>
  );
}

export function AgentsAdmin({
  agents,
  branches,
}: {
  agents: AdminAgent[];
  branches: AdminBranch[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdminResult | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const supervisors = agents.filter(
    (a) => a.role === 'field_supervisor' && a.employmentStatus === 'active',
  );

  const handle = async (fn: () => Promise<AdminResult>) => {
    setBusy(true);
    setResult(null);
    const r = await fn();
    setResult(r);
    if (r.status === 'ok') {
      if (r.tempPassword !== undefined) setTempPassword(r.tempPassword);
      setCreating(false);
      setEditing(null);
      router.refresh();
    }
    setBusy(false);
  };

  const formFields = (agent: AdminAgent | null) => (
    <>
      {agent === null && (
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Employee number</span>
          <input
            name="employeeNo"
            required
            placeholder="DTG-0008"
            className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm uppercase"
          />
        </label>
      )}
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Buong pangalan</span>
        <input
          name="fullName"
          required
          defaultValue={agent?.fullName ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Mobile</span>
        <input
          name="mobileNo"
          defaultValue={agent?.mobileNo ?? ''}
          placeholder="+639171234567"
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Role</span>
        <select
          name="role"
          defaultValue={agent?.role ?? 'collector'}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-2 text-sm"
        >
          {Object.entries(ROLE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Branch</span>
        <select
          name="branchId"
          defaultValue={agent?.branchId ?? branches[0]?.id ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-2 text-sm"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-gray-600">Supervisor</span>
        <select
          name="supervisorAgentId"
          defaultValue={agent?.supervisorAgentId ?? ''}
          className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-2 text-sm"
        >
          <option value="">— wala —</option>
          {supervisors
            .filter((s) => s.id !== agent?.id)
            .map((s) => (
              <option key={s.id} value={s.id}>{s.fullName}</option>
            ))}
        </select>
      </label>
      {agent !== null && (
        <label className="block">
          <span className="text-xs font-medium text-gray-600">Employment status</span>
          <select
            name="employmentStatus"
            defaultValue={agent.employmentStatus}
            className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-2 text-sm"
          >
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );

  const readForm = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const str = (k: string): string => String(fd.get(k) ?? '').trim();
    const nullable = (k: string): string | null => {
      const v = str(k);
      return v.length > 0 ? v : null;
    };
    return { fd, str, nullable };
  };

  return (
    <div className="space-y-5">
      {tempPassword !== null && (
        <TempPasswordBanner
          password={tempPassword}
          onDismiss={() => setTempPassword(null)}
        />
      )}

      {result !== null && result.status === 'error' && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {result.message}
        </p>
      )}
      {result !== null && result.status === 'ok' && tempPassword === null && (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {result.message}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => { setCreating((c) => !c); setEditing(null); }}
          className="rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white"
        >
          {creating ? 'Kanselahin' : '+ Bagong ahente'}
        </button>
      </div>

      {creating && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { str, nullable } = readForm(e.currentTarget);
            void handle(() =>
              createAgentAction({
                employeeNo: str('employeeNo'),
                fullName: str('fullName'),
                mobileNo: nullable('mobileNo'),
                role: str('role'),
                branchId: str('branchId'),
                supervisorAgentId: nullable('supervisorAgentId'),
              }),
            );
          }}
          className="grid gap-3 rounded-2xl border border-gray-300 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {formFields(null)}
          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="h-11 rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white disabled:bg-gray-300"
            >
              {busy ? 'Ginagawa…' : 'Gumawa ng account'}
            </button>
            <p className="mt-2 text-xs text-gray-500">
              Gagawa ito ng login na{' '}
              <code>employee_no@datung.internal</code> at magbibigay ng
              pansamantalang password na ipapakita nang isang beses.
            </p>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Branch</th>
              <th className="px-4 py-3">Supervisor</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {agents.map((agent) => {
              const branch = branches.find((b) => b.id === agent.branchId);
              const supervisor = agents.find((a) => a.id === agent.supervisorAgentId);
              return (
                <>
                  <tr
                    key={agent.id}
                    className={agent.employmentStatus !== 'active' ? 'bg-gray-50 text-gray-400' : undefined}
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">{agent.fullName}</span>
                      <span className="block text-xs text-gray-500">
                        {agent.employeeNo}
                        {agent.authUserId === null && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">
                            walang login
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3">{ROLE_LABELS[agent.role] ?? agent.role}</td>
                    <td className="px-4 py-3">{branch?.code ?? '—'}</td>
                    <td className="px-4 py-3">{supervisor?.fullName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          agent.employmentStatus === 'active'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gray-200 text-gray-700'
                        }`}
                      >
                        {STATUS_LABELS[agent.employmentStatus] ?? agent.employmentStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => { setEditing(editing === agent.id ? null : agent.id); setCreating(false); }}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50"
                      >
                        I-edit
                      </button>
                      {agent.authUserId !== null && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void handle(() =>
                              resetPasswordAction({
                                agentId: agent.id,
                                authUserId: agent.authUserId as string,
                              }),
                            )
                          }
                          className="ml-2 rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50"
                        >
                          Reset password
                        </button>
                      )}
                    </td>
                  </tr>
                  {editing === agent.id && (
                    <tr key={`${agent.id}-edit`}>
                      <td colSpan={6} className="bg-gray-50 px-4 py-4">
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const { str, nullable } = readForm(e.currentTarget);
                            void handle(() =>
                              updateAgentAction({
                                agentId: agent.id,
                                fullName: str('fullName'),
                                mobileNo: nullable('mobileNo'),
                                role: str('role'),
                                branchId: str('branchId'),
                                supervisorAgentId: nullable('supervisorAgentId'),
                                employmentStatus: str('employmentStatus'),
                              }),
                            );
                          }}
                          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                        >
                          {formFields(agent)}
                          <div className="sm:col-span-2 lg:col-span-3">
                            <button
                              type="submit"
                              disabled={busy}
                              className="h-10 rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white disabled:bg-gray-300"
                            >
                              I-save
                            </button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
