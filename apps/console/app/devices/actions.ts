'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { adminClient, currentConsoleUser } from '../../lib/supabase';

const approveSchema = z.object({ requestCode: z.string().min(1).max(16) });
const rejectSchema = z.object({
  flagId: z.uuid(),
  reason: z.string().trim().min(5, 'Kailangan ng dahilan.').max(500),
});

export type DeviceActionResult =
  | { status: 'ok'; agentName?: string }
  | { status: 'invalid_code' }
  | { status: 'forbidden' }
  | { status: 'invalid'; message: string };

// Approve: delegates entirely to approve_device_rebind_tx, which revokes the
// old binding, promotes the new device, resolves the flag and writes
// audit_log in ONE transaction — and re-verifies the supervisor tree itself.
// The console never performs those steps individually.
export async function approveRebindAction(
  input: unknown,
): Promise<DeviceActionResult> {
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_code' };
  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden' };

  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const { data, error } = await adminClient().rpc('approve_device_rebind_tx', {
    p_supervisor_auth_user_id: user.authUserId,
    p_request_code: parsed.data.requestCode,
    p_caller_ip: ip,
  });
  if (error !== null) return { status: 'forbidden' };

  const result = data as { status?: string; agent_full_name?: string } | null;
  if (result?.status === 'approved') {
    revalidatePath('/devices');
    return { status: 'ok', agentName: result.agent_full_name };
  }
  if (result?.status === 'forbidden') return { status: 'forbidden' };
  return { status: 'invalid_code' };
}

// Reject: the pending device is NOT bound and the flag is resolved with the
// supervisor's reason. The agent stays on their existing device and has to
// talk to someone — which is the point.
export async function rejectRebindAction(
  input: unknown,
): Promise<DeviceActionResult> {
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 'invalid',
      message: parsed.error.issues[0]?.message ?? 'Kailangan ng dahilan.',
    };
  }
  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden' };

  // Runs through RLS as the supervisor (flags_update_resolve_reports), so an
  // out-of-tree flag simply matches no rows.
  const { userClient } = await import('../../lib/supabase');
  const supabase = await userClient();
  const { error } = await supabase
    .from('integrity_flags')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by_agent_id: user.agentId,
      resolution_note: `Rebind REJECTED: ${parsed.data.reason}`,
    })
    .eq('id', parsed.data.flagId)
    .is('resolved_at', null);
  if (error !== null) return { status: 'forbidden' };

  revalidatePath('/devices');
  return { status: 'ok' };
}
