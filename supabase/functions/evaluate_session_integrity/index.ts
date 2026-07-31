// evaluate_session_integrity — on-demand integrity evaluation for one session.
//
// The scheduled path is pg_cron (evaluate_pending_sessions, every 5 minutes,
// picking up sessions closed 10+ minutes ago). This function exists for the
// console: a supervisor opening a session that has not been scored yet, or
// re-running an evaluation after resolving flags.
//
// It computes NOTHING itself. All detection lives in
// public.evaluate_session_integrity() so the scheduled path and the on-demand
// path can never disagree about what a flag means.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@4';
import { jsonResponse, preflightResponse } from '../_shared/http.ts';

const requestSchema = z.object({ session_id: z.string().uuid() });

const resultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    session_id: z.string(),
    integrity_score: z.number(),
    critical_flags: z.number(),
    warn_flags: z.number(),
  }),
  z.object({ status: z.literal('not_found') }),
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonResponse(500, { error: 'misconfigured' });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse(401, { error: 'unauthorized' });

  const asCaller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'bad_request' });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Only a supervisor whose reporting tree contains the session's agent may
  // trigger an evaluation. is_supervisor_of() is the same recursive check the
  // RLS policies use, so console access and read access cannot drift apart.
  const { data: session } = await admin
    .from('attendance_sessions')
    .select('agent_id')
    .eq('id', parsed.data.session_id)
    .maybeSingle();
  if (session === null) return jsonResponse(404, { status: 'not_found' });

  const { data: allowed, error: treeError } = await asCaller.rpc(
    'is_supervisor_of',
    { target_agent_id: session.agent_id },
  );
  if (treeError !== null || allowed !== true) {
    return jsonResponse(403, { error: 'forbidden' });
  }

  const { data, error } = await admin.rpc('evaluate_session_integrity', {
    p_session_id: parsed.data.session_id,
  });
  if (error !== null) {
    console.error('evaluate_session_integrity failed', error);
    return jsonResponse(500, { error: 'internal' });
  }

  const result = resultSchema.safeParse(data);
  if (!result.success) {
    console.error('unexpected shape from evaluate_session_integrity', data);
    return jsonResponse(500, { error: 'internal' });
  }
  if (result.data.status === 'not_found') {
    return jsonResponse(404, { status: 'not_found' });
  }
  return jsonResponse(200, result.data);
});
