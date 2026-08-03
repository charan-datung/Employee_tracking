'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { currentConsoleUser, userClient } from '../../../../../lib/supabase';

// Both actions run AS THE SUPERVISOR through RLS — no service key. The
// policies flags_update_resolve_reports and sessions_update_void_reports
// already require the target agent to be in the caller's reporting tree, so
// authority is enforced by the database on every call, not re-implemented
// here.

const resolveSchema = z.object({
  flagIds: z.array(z.uuid()).min(1),
  note: z.string().trim().min(1, 'a note is required').max(1000),
});

export type ActionResult =
  | { status: 'ok'; count?: number }
  | { status: 'invalid'; message: string }
  | { status: 'forbidden' };

/** Resolve one or more flags with a shared note. A note is mandatory: a
 *  resolved flag with no explanation is indistinguishable from a dismissed
 *  one six months later. */
export async function resolveFlagsAction(input: unknown): Promise<ActionResult> {
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 'invalid',
      message: parsed.error.issues[0]?.message ?? 'Kailangan ng tala.',
    };
  }
  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden' };

  const supabase = await userClient();
  const { data, error } = await supabase
    .from('integrity_flags')
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by_agent_id: user.agentId,
      resolution_note: parsed.data.note,
    })
    .in('id', parsed.data.flagIds)
    .is('resolved_at', null)
    .select('id');

  if (error !== null) return { status: 'forbidden' };
  revalidatePath('/flags');
  revalidatePath('/');
  return { status: 'ok', count: data?.length ?? 0 };
}

const voidSchema = z.object({
  sessionId: z.uuid(),
  reason: z.string().trim().min(10, 'Kailangan ng dahilan (10+ letra).').max(1000),
});

/** Void a session. Reason required by both this schema and the RLS policy's
 *  WITH CHECK, so a reasonless void is impossible even outside this UI. */
export async function voidSessionAction(input: unknown): Promise<ActionResult> {
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: 'invalid',
      message: parsed.error.issues[0]?.message ?? 'Kailangan ng dahilan.',
    };
  }
  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden' };

  const supabase = await userClient();
  const { error } = await supabase
    .from('attendance_sessions')
    .update({
      status: 'voided',
      void_reason: parsed.data.reason,
      voided_by_agent_id: user.agentId,
    })
    .eq('id', parsed.data.sessionId);

  if (error !== null) return { status: 'forbidden' };

  // audit_log is written by the database, never from here: INSERT is revoked
  // for every role including service_role, so the trigger/definer path is the
  // only way in and cannot be bypassed by a console bug.
  revalidatePath('/');
  return { status: 'ok' };
}
