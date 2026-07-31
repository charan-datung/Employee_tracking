import { z } from 'zod';
import { kvStore } from '../../lib/kvStore.ts';
import type { Position } from './sql.ts';

// Last known device position, used ONLY to order the client list and to gate
// the visit screen offline. Written from verified fixes and persisted pings —
// both of which only exist inside an open session, so this never becomes a
// back door to tracking a checked-out agent (CLAUDE.md rule 4). Cleared on
// check-out.

const KEY = 'datung.position.last';

const storedSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  atMs: z.number(),
});

export async function getLastPosition(): Promise<Position | null> {
  const raw = await kvStore.get(KEY);
  if (raw === null) return null;
  try {
    const parsed = storedSchema.parse(JSON.parse(raw));
    return { lat: parsed.lat, lng: parsed.lng };
  } catch {
    await kvStore.remove(KEY);
    return null;
  }
}

export async function setLastPosition(
  lat: number,
  lng: number,
  atMs: number,
): Promise<void> {
  await kvStore.set(KEY, JSON.stringify({ lat, lng, atMs }));
}

export async function clearLastPosition(): Promise<void> {
  await kvStore.remove(KEY);
}
