// register_device — called once per login by the mobile app.
// Authenticates the agent's JWT, then lets register_device_tx (SECURITY
// DEFINER, service_role-only) decide bind / ok / blocked. The client never
// writes devices or integrity_flags itself; the server decides facts.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@4';
import { corsHeaders, jsonResponse, preflightResponse } from '../_shared/http.ts';

const requestSchema = z.object({
  android_id: z.string().min(1).max(64),
  device_model: z.string().max(120).nullable().default(null),
  manufacturer: z.string().max(120).nullable().default(null),
  os_version: z.string().max(60).nullable().default(null),
  webview_version: z.string().max(60).nullable().default(null),
  app_version: z.string().max(60).nullable().default(null),
});

const txResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('bound'), device_id: z.string() }),
  z.object({ status: z.literal('ok'), device_id: z.string() }),
  z.object({ status: z.literal('blocked'), request_code: z.string() }),
  z.object({ status: z.literal('no_agent') }),
  z.object({ status: z.literal('not_active') }),
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
  const { data, error } = await admin.rpc('register_device_tx', {
    p_auth_user_id: userData.user.id,
    p_android_id: parsed.data.android_id,
    p_device_model: parsed.data.device_model,
    p_manufacturer: parsed.data.manufacturer,
    p_os_version: parsed.data.os_version,
    p_webview_version: parsed.data.webview_version,
    p_app_version: parsed.data.app_version,
  });
  if (error) {
    console.error('register_device_tx failed', error);
    return jsonResponse(500, { error: 'internal' });
  }

  const result = txResultSchema.safeParse(data);
  if (!result.success) {
    console.error('register_device_tx returned unexpected shape', data);
    return jsonResponse(500, { error: 'internal' });
  }

  switch (result.data.status) {
    case 'bound':
    case 'ok':
    case 'blocked':
      return jsonResponse(200, result.data);
    case 'no_agent':
    case 'not_active':
      // Auth user exists but is not an active agent. Deliberately generic.
      return jsonResponse(403, { error: 'forbidden' });
  }
});
