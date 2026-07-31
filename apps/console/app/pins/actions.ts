'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { adminClient, currentConsoleUser } from '../../lib/supabase';

const fixPinSchema = z.object({
  clientId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  note: z.string().max(500).nullable(),
});

export type FixPinResult =
  | { status: 'ok' }
  | { status: 'forbidden' }
  | { status: 'invalid' }
  | { status: 'error' };

// "Fix pin": the console half of the pin quality loop. The dragged marker
// position becomes the client's coordinates and marks geocode_confidence
// 'exact' — a human looked at a map and placed it deliberately.
//
// Authority is checked twice: here (must be an active field_supervisor) and
// again inside fix_client_pin(), which re-derives the actor from the auth id
// and writes the audit row. The service key only carries the call.
export async function fixPinAction(input: unknown): Promise<FixPinResult> {
  const parsed = fixPinSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid' };

  const user = await currentConsoleUser();
  if (user === null) return { status: 'forbidden' };

  const headerList = await headers();
  const ip = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const { data, error } = await adminClient().rpc('fix_client_pin', {
    p_actor_auth_user_id: user.authUserId,
    p_client_id: parsed.data.clientId,
    p_lat: parsed.data.lat,
    p_lng: parsed.data.lng,
    p_note: parsed.data.note,
    p_caller_ip: ip,
  });

  if (error !== null) return { status: 'error' };
  const status = (data as { status?: string } | null)?.status;
  if (status === 'ok') {
    revalidatePath('/pins');
    return { status: 'ok' };
  }
  if (status === 'forbidden') return { status: 'forbidden' };
  return { status: 'invalid' };
}
