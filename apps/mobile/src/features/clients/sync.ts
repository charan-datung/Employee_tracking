import { clientRowSchema, type ClientRow } from '@datung/shared';
import { supabase } from '../../lib/supabaseClient';
import { sqlPort } from '../../services/sync/db.ts';
import { REPLACE_CLIENTS_SQL } from './sql.ts';

// Pulls the agent's client book into SQLite. RLS already restricts the rows
// to their assignments (clients_select_assigned), so this is a plain select —
// there is no client-side filter to get wrong.
//
// Full replace inside ONE transaction: clients_local and clients_fts are
// rewritten together so search can never drift from the list. The book is
// small (a few hundred rows per agent), so replace is simpler and safer than
// a delta sync, and a failed pull leaves the previous book intact.

const SYNCED_AT_KEY = 'clients_synced_at';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SELECT_COLUMNS =
  'id, external_ref, display_name, account_type, address_text, barangay, ' +
  'city, lat, lng, geofence_radius_m, geocode_confidence, is_active';

async function getSyncedAt(): Promise<number | null> {
  const rows = await sqlPort.query<{ value: string }>(
    'select value from meta where key = ?',
    [SYNCED_AT_KEY],
  );
  const raw = rows[0]?.value;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStatements(
  clients: ClientRow[],
  nowMs: number,
): { statement: string; values: unknown[] }[] {
  const statements: { statement: string; values: unknown[] }[] = [
    { statement: REPLACE_CLIENTS_SQL.clearClients, values: [] },
    { statement: REPLACE_CLIENTS_SQL.clearFts, values: [] },
  ];
  for (const c of clients) {
    statements.push({
      statement: REPLACE_CLIENTS_SQL.insertClient,
      values: [
        c.id,
        c.external_ref,
        c.display_name,
        c.account_type,
        c.address_text,
        c.barangay,
        c.city,
        c.lat,
        c.lng,
        c.geofence_radius_m,
        c.geocode_confidence,
        c.is_active ? 1 : 0,
        nowMs,
      ],
    });
    statements.push({
      statement: REPLACE_CLIENTS_SQL.insertFts,
      values: [c.id, c.display_name, c.external_ref ?? '', c.barangay ?? ''],
    });
  }
  statements.push({
    statement:
      'insert into meta (key, value) values (?, ?) ' +
      'on conflict (key) do update set value = excluded.value',
    values: [SYNCED_AT_KEY, String(nowMs)],
  });
  return statements;
}

/** Pulls and replaces the local book. Throws if the network/RLS call fails. */
export async function syncClients(): Promise<number> {
  const { data, error } = await supabase.from('clients').select(SELECT_COLUMNS);
  if (error !== null) throw error;
  // zod-validate the network boundary before anything reaches SQLite.
  const clients = clientRowSchema.array().parse(data ?? []);
  await sqlPort.runSet(toStatements(clients, Date.now()));
  return clients.length;
}

/**
 * Sync on login and once a day thereafter. Never throws: an agent who opens
 * the app underground still gets yesterday's book, which is the whole point
 * of keeping it local.
 */
export async function syncClientsIfStale(
  opts: { force?: boolean } = {},
): Promise<{ synced: boolean; count: number | null }> {
  try {
    const syncedAt = await getSyncedAt();
    const stale =
      opts.force === true ||
      syncedAt === null ||
      Date.now() - syncedAt > REFRESH_INTERVAL_MS;
    if (!stale) return { synced: false, count: null };
    const count = await syncClients();
    return { synced: true, count };
  } catch {
    return { synced: false, count: null };
  }
}
