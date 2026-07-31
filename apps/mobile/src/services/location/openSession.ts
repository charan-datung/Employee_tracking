import { z } from 'zod';
import { kvStore } from '../../lib/kvStore.ts';
import type { OpenSessionRef } from './types.ts';

// Local record of the currently open attendance session. The attendance
// feature (check-in/check-out, later change) is the ONLY writer; the location
// service reads it to enforce the CLAUDE.md rule 4 invariant — no open
// session, no location sampling. Cleared on check-out and on logout.

const KEY = 'datung.session.open';

const openSessionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
});

export async function getOpenSessionLocal(): Promise<OpenSessionRef | null> {
  const raw = await kvStore.get(KEY);
  if (raw === null) return null;
  try {
    return openSessionSchema.parse(JSON.parse(raw));
  } catch {
    await kvStore.remove(KEY);
    return null;
  }
}

export async function setOpenSessionLocal(ref: OpenSessionRef): Promise<void> {
  await kvStore.set(KEY, JSON.stringify(openSessionSchema.parse(ref)));
}

export async function clearOpenSessionLocal(): Promise<void> {
  await kvStore.remove(KEY);
}
