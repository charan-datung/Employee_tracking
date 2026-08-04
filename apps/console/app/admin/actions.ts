'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { adminClient, currentConsoleUser } from '../../lib/supabase';
import { generateTempPassword } from '../../lib/tempPassword';

// Roster administration.
//
// PROVISIONING IS A TWO-SYSTEM OPERATION and that is the whole difficulty:
// the login lives in Supabase Auth (only the Auth Admin API can create it,
// because passwords are hashed and auth.identities must be written), while
// the agent record lives in our schema. There is no transaction spanning
// both. So the order is deliberate:
//
//   1. create the auth user
//   2. call admin_create_agent()
//   3. if step 2 fails for ANY reason, DELETE the auth user from step 1
//
// Without step 3 a failed provisioning leaves an orphaned login that nobody
// can see in the console but that still authenticates — which is why
// admin_create_agent() returns a status instead of raising: a clean status
// makes the rollback deterministic.

const ADMIN_EMAIL_DOMAIN = 'datung.internal';

const createSchema = z.object({
  employeeNo: z.string().trim().regex(/^[A-Za-z0-9-]{3,32}$/, 'Employee number: letters, numbers, dashes.'),
  fullName: z.string().trim().min(2).max(120),
  mobileNo: z.string().trim().max(24).nullable(),
  role: z.enum(['sales_agent', 'collector', 'field_supervisor', 'admin']),
  branchId: z.uuid(),
  supervisorAgentId: z.uuid().nullable(),
});

export type AdminResult =
  | { status: 'ok'; message?: string; tempPassword?: string }
  | { status: 'error'; message: string };

function humanError(status: string): string {
  switch (status) {
    case 'forbidden': return 'Admin lang ang puwedeng gumawa ng account.';
    case 'duplicate_employee_no': return 'May account na ang employee number na iyan.';
    case 'duplicate_code': return 'Ginagamit na ang branch code na iyan.';
    case 'self_supervision': return 'Hindi puwedeng siya rin ang supervisor niya.';
    case 'invalid_coordinates': return 'Mali ang coordinates.';
    case 'auth_user_missing': return 'Nawala ang bagong login habang ginagawa. Subukan ulit.';
    case 'not_found': return 'Hindi mahanap ang record.';
    default: return 'Hindi natapos ang aksyon.';
  }
}

export async function createAgentAction(input: unknown): Promise<AdminResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Kulang ang detalye.' };
  }
  const user = await currentConsoleUser();
  if (user === null || !user.isAdmin) {
    return { status: 'error', message: humanError('forbidden') };
  }

  const admin = adminClient();
  const employeeNo = parsed.data.employeeNo.toUpperCase();
  const email = `${employeeNo.toLowerCase()}@${ADMIN_EMAIL_DOMAIN}`;
  const tempPassword = generateTempPassword();

  // Step 1 — the login.
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    // Agents have no real mailbox, so there is no confirmation link to click.
    email_confirm: true,
    user_metadata: { employee_no: employeeNo, full_name: parsed.data.fullName },
  });
  if (authError !== null || created.user === null) {
    const duplicate = /already|registered|exists/i.test(authError?.message ?? '');
    return {
      status: 'error',
      message: duplicate
        ? 'May login na ang employee number na iyan.'
        : `Hindi nagawa ang login: ${authError?.message ?? 'unknown'}`,
    };
  }

  // Step 2 — the agent record.
  const { data, error } = await admin.rpc('admin_create_agent', {
    p_actor_auth_user_id: user.authUserId,
    p_new_auth_user_id: created.user.id,
    p_employee_no: employeeNo,
    p_full_name: parsed.data.fullName,
    p_mobile_no: parsed.data.mobileNo,
    p_role: parsed.data.role,
    p_branch_id: parsed.data.branchId,
    p_supervisor_agent_id: parsed.data.supervisorAgentId,
  });

  const status = (data as { status?: string } | null)?.status;
  if (error !== null || status !== 'ok') {
    // Step 3 — roll the login back so no orphan can authenticate.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => undefined);
    return { status: 'error', message: humanError(status ?? 'unknown') };
  }

  revalidatePath('/admin/agents');
  revalidatePath('/');
  return {
    status: 'ok',
    message: `Nagawa ang account ni ${parsed.data.fullName}.`,
    tempPassword,
  };
}

const updateSchema = z.object({
  agentId: z.uuid(),
  fullName: z.string().trim().min(2).max(120),
  mobileNo: z.string().trim().max(24).nullable(),
  role: z.enum(['sales_agent', 'collector', 'field_supervisor', 'admin']),
  branchId: z.uuid(),
  supervisorAgentId: z.uuid().nullable(),
  employmentStatus: z.enum(['active', 'suspended', 'separated']),
});

export async function updateAgentAction(input: unknown): Promise<AdminResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Kulang ang detalye.' };
  }
  const user = await currentConsoleUser();
  if (user === null || !user.isAdmin) {
    return { status: 'error', message: humanError('forbidden') };
  }

  const { data, error } = await adminClient().rpc('admin_update_agent', {
    p_actor_auth_user_id: user.authUserId,
    p_agent_id: parsed.data.agentId,
    p_full_name: parsed.data.fullName,
    p_mobile_no: parsed.data.mobileNo,
    p_role: parsed.data.role,
    p_branch_id: parsed.data.branchId,
    p_supervisor_agent_id: parsed.data.supervisorAgentId,
    p_employment_status: parsed.data.employmentStatus,
  });
  const status = (data as { status?: string } | null)?.status;
  if (error !== null || status !== 'ok') {
    return { status: 'error', message: humanError(status ?? 'unknown') };
  }

  revalidatePath('/admin/agents');
  revalidatePath('/');
  return { status: 'ok', message: 'Na-update.' };
}

const resetSchema = z.object({ agentId: z.uuid(), authUserId: z.uuid() });

/**
 * Password reset.
 *
 * Agents have no email address, so there is no self-service reset link to
 * send — the ONLY recovery path is an admin issuing a temporary password and
 * reading it to them. That is a deliberate consequence of the synthetic-email
 * design, and it is why the reset is audited: someone with this button can
 * take over any account, so every use leaves a record.
 */
export async function resetPasswordAction(input: unknown): Promise<AdminResult> {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', message: 'Mali ang request.' };
  const user = await currentConsoleUser();
  if (user === null || !user.isAdmin) {
    return { status: 'error', message: humanError('forbidden') };
  }

  const admin = adminClient();
  const tempPassword = generateTempPassword();
  const { error } = await admin.auth.admin.updateUserById(parsed.data.authUserId, {
    password: tempPassword,
  });
  if (error !== null) {
    return { status: 'error', message: `Hindi na-reset: ${error.message}` };
  }

  // Audited even though no password ever touches our database.
  await admin.rpc('admin_log_password_reset', {
    p_actor_auth_user_id: user.authUserId,
    p_agent_id: parsed.data.agentId,
  });

  return {
    status: 'ok',
    message: 'Bagong pansamantalang password. Ibigay ito sa ahente ngayon.',
    tempPassword,
  };
}

const branchSchema = z.object({
  branchId: z.uuid().nullable(),
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().regex(/^[A-Za-z0-9]{2,10}$/, 'Branch code: 2-10 letters/numbers.'),
  address: z.string().trim().max(300).nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(20).max(2000),
  isActive: z.boolean(),
});

export async function upsertBranchAction(input: unknown): Promise<AdminResult> {
  const parsed = branchSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Kulang ang detalye.' };
  }
  const user = await currentConsoleUser();
  if (user === null || !user.isAdmin) {
    return { status: 'error', message: humanError('forbidden') };
  }

  const { data, error } = await adminClient().rpc('admin_upsert_branch', {
    p_actor_auth_user_id: user.authUserId,
    p_branch_id: parsed.data.branchId,
    p_name: parsed.data.name,
    p_code: parsed.data.code.toUpperCase(),
    p_address: parsed.data.address,
    p_lat: parsed.data.lat,
    p_lng: parsed.data.lng,
    p_geofence_radius_m: parsed.data.geofenceRadiusM,
    p_is_active: parsed.data.isActive,
  });
  const status = (data as { status?: string } | null)?.status;
  if (error !== null || status !== 'ok') {
    return { status: 'error', message: humanError(status ?? 'unknown') };
  }
  revalidatePath('/admin/branches');
  return { status: 'ok', message: 'Na-save ang branch.' };
}

const assignSchema = z.object({
  clientIds: z.array(z.uuid()).min(1).max(500),
  agentId: z.uuid().nullable(),
});

export async function assignClientsAction(input: unknown): Promise<AdminResult> {
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) return { status: 'error', message: 'Pumili ng client.' };
  const user = await currentConsoleUser();
  if (user === null || !user.isAdmin) {
    return { status: 'error', message: humanError('forbidden') };
  }

  const { data, error } = await adminClient().rpc('admin_assign_clients', {
    p_actor_auth_user_id: user.authUserId,
    p_client_ids: parsed.data.clientIds,
    p_agent_id: parsed.data.agentId,
  });
  const result = data as { status?: string; count?: number } | null;
  if (error !== null || result?.status !== 'ok') {
    return { status: 'error', message: humanError(result?.status ?? 'unknown') };
  }
  revalidatePath('/clients');
  return { status: 'ok', message: `Na-assign ang ${result.count ?? 0} client.` };
}
