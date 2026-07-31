// approve_device_rebind — a field supervisor submits the 6-char code an agent
// read to them by phone. approve_device_rebind_tx (SECURITY DEFINER,
// service_role-only) verifies the supervisor's reporting tree, revokes the
// old device, binds the new one, resolves the flag, and writes audit_log —
// all in one transaction.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@4';
import { jsonResponse, preflightResponse } from '../_shared/http.ts';

const requestSchema = z.object({
  request_code: z.string().min(1).max(16),
});

const txResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('approved'),
    agent_employee_no: z.string(),
    agent_full_name: z.string(),
    device_model: z.string().nullable(),
  }),
  z.object({ status: z.literal('invalid_code') }),
  z.object({ status: z.literal('forbidden') }),
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

  const callerIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc('approve_device_rebind_tx', {
    p_supervisor_auth_user_id: userData.user.id,
    p_request_code: parsed.data.request_code,
    p_caller_ip: callerIp,
  });
  if (error) {
    console.error('approve_device_rebind_tx failed', error);
    return jsonResponse(500, { error: 'internal' });
  }

  const result = txResultSchema.safeParse(data);
  if (!result.success) {
    console.error('approve_device_rebind_tx returned unexpected shape', data);
    return jsonResponse(500, { error: 'internal' });
  }

  switch (result.data.status) {
    case 'approved':
      return jsonResponse(200, result.data);
    case 'invalid_code':
      return jsonResponse(404, { status: 'invalid_code' });
    case 'forbidden':
      return jsonResponse(403, { status: 'forbidden' });
  }
});
