import type { LocalPing } from './types.ts';

// Interim ping sink: an in-memory buffer the future sync engine drains.
//
// KNOWN LIMITATION (accepted until the SQLite offline queue lands with the
// sync engine): pings buffered here are lost if Android kills the app before
// a drain. The server detects the resulting gaps via the ping_gap flag, so
// the loss is visible, not silent. Replace `persist` with an insert into the
// @capacitor-community/sqlite queue when the sync engine is built — the
// LocationService only knows the PingSink interface, so this is the single
// swap point.

const buffer: LocalPing[] = [];

export async function persistPingToBuffer(ping: LocalPing): Promise<void> {
  buffer.push(ping);
}

export function drainPingBuffer(): LocalPing[] {
  return buffer.splice(0, buffer.length);
}

export function peekPingBuffer(): ReadonlyArray<LocalPing> {
  return buffer;
}
