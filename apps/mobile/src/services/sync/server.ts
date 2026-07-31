import { env } from '../../lib/env';
import { supabase } from '../../lib/supabaseClient';
import type { EntityType, PushOutcome, ServerPort } from './types.ts';

// Real ServerPort over PostgREST. Raw fetch instead of supabase-js query
// methods for two reasons: the Date response header is the server timestamp
// used for clock-offset measurement (task rule 5), and Prefer:
// resolution=ignore-duplicates gives ON CONFLICT (id) DO NOTHING semantics so
// a retried POST can never duplicate (task rule 2, client-generated UUIDs).

const INSERT_TABLE: Partial<Record<EntityType, string>> = {
  session_open: 'attendance_sessions',
  visit: 'visits',
  ping: 'location_pings',
  flag: 'integrity_flags',
};

function outcomeFromStatus(status: number, detail: string): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 401) return { kind: 'auth' };
  if (status === 409) return { kind: 'conflict', detail };
  if (status >= 400 && status < 500) return { kind: 'permanent', detail };
  return { kind: 'transient', detail };
}

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function push(
  entityType: EntityType,
  payloads: Record<string, unknown>[],
): Promise<PushOutcome> {
  const token = await accessToken();
  if (token === null) return { kind: 'auth' };
  const headers = {
    apikey: env.VITE_SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    let res: Response;
    if (entityType === 'session_close') {
      // Close is an UPDATE of the agent's own open session (RLS policy
      // sessions_update_close_own). One row per call.
      const payload = payloads[0];
      if (payload === undefined) return { kind: 'ok' };
      const { id, ...fields } = payload;
      res = await fetch(
        `${env.VITE_SUPABASE_URL}/rest/v1/attendance_sessions?id=eq.${String(id)}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(fields),
        },
      );
    } else {
      const table = INSERT_TABLE[entityType];
      if (table === undefined) {
        return { kind: 'permanent', detail: `no table for ${entityType}` };
      }
      res = await fetch(
        `${env.VITE_SUPABASE_URL}/rest/v1/${table}?on_conflict=id`,
        {
          method: 'POST',
          headers: {
            ...headers,
            Prefer: 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify(payloads),
        },
      );
    }
    if (res.ok) return { kind: 'ok' };
    const body = await res.text().catch(() => '');
    return outcomeFromStatus(res.status, `${res.status} ${body.slice(0, 300)}`);
  } catch (error) {
    return {
      kind: 'transient',
      detail: error instanceof Error ? error.message : 'network failure',
    };
  }
}

export const serverPort: ServerPort = {
  async serverNowMs() {
    // Any authenticated-or-not response carries a Date header stamped by the
    // server — a cheap clock reference and reachability probe in one.
    try {
      const res = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: env.VITE_SUPABASE_ANON_KEY },
      });
      const date = res.headers.get('Date');
      if (date === null) return null;
      const ms = Date.parse(date);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  },

  pushBatch: (entityType, payloads) => push(entityType, payloads),
  pushOne: (entityType, payload) => push(entityType, [payload]),

  async refreshAuth() {
    const { data, error } = await supabase.auth.refreshSession();
    return error === null && data.session !== null;
  },
};
