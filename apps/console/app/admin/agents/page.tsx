import { requireAdmin, userClient } from '../../../lib/supabase';
import { AgentsAdmin, type AdminAgent, type AdminBranch } from './AgentsAdmin';

export const dynamic = 'force-dynamic';

// Roster administration. requireAdmin() bounces supervisors — they can review
// sessions but must not be able to mint accounts.
export default async function AgentsAdminPage() {
  await requireAdmin();
  const supabase = await userClient();

  // Read as the admin: the agents_select_admin RLS policy returns the whole
  // roster only because am_i_admin() is true.
  const { data: agentData } = await supabase
    .from('agents')
    .select(
      'id, auth_user_id, employee_no, full_name, mobile_no, role, branch_id, ' +
        'supervisor_agent_id, employment_status',
    )
    .order('employee_no');
  const { data: branchData } = await supabase
    .from('branches')
    .select('id, name, code')
    .order('code');

  // supabase-js needs generated Database types to infer these; cast
  // explicitly and keep the cast in step with the SELECT above.
  const agentRows = (agentData ?? []) as unknown as Record<string, unknown>[];
  const branchRows = (branchData ?? []) as unknown as Record<string, unknown>[];

  const agents: AdminAgent[] = agentRows.map((a) => ({
    id: String(a['id']),
    authUserId: (a['auth_user_id'] as string | null) ?? null,
    employeeNo: String(a['employee_no']),
    fullName: String(a['full_name']),
    mobileNo: (a['mobile_no'] as string | null) ?? null,
    role: String(a['role']),
    branchId: String(a['branch_id']),
    supervisorAgentId: (a['supervisor_agent_id'] as string | null) ?? null,
    employmentStatus: String(a['employment_status']),
  }));
  const branches: AdminBranch[] = branchRows.map((b) => ({
    id: String(b['id']),
    name: String(b['name']),
    code: String(b['code']),
  }));

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Mga ahente</h1>
        <p className="mt-1 text-sm text-gray-500">
          {agents.length} sa roster · {branches.length} branch. Dito ginagawa
          ang mga account — walang ibang paraan para makapag-login ang bagong
          ahente.
        </p>
      </header>
      <div className="mt-6">
        <AgentsAdmin agents={agents} branches={branches} />
      </div>
    </main>
  );
}
