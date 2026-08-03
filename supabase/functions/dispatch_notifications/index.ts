// dispatch_notifications — turns queued notification rows into FCM sends.
//
// It decides NOTHING. Recipients, copy, and the rate limit all come from the
// SQL queue functions (20260731070100_push_dispatch.sql), so the policy is
// inspectable in one place and the same whether it is triggered by cron or by
// hand. This function is transport.
//
// Invoked by pg_cron via pg_net with the service key, never by a browser.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { z } from 'npm:zod@4';
import { jsonResponse, preflightResponse } from '../_shared/http.ts';

const requestSchema = z.object({
  mode: z.enum(['critical_flag', 'not_checked_in_digest', 'open_sessions_digest']),
});

const QUEUE_FN: Record<string, string> = {
  critical_flag: 'queue_critical_flag_pushes',
  not_checked_in_digest: 'queue_not_checked_in_digest',
  open_sessions_digest: 'queue_open_sessions_digest',
};

interface QueuedPush {
  notification_id: string;
  push_token: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
}

// FCM HTTP v1 needs an OAuth token minted from the service account. Cached
// for the lifetime of the isolate so a burst of sends does not mint one per
// message.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function fcmAccessToken(serviceAccountJson: string): Promise<string | null> {
  if (cachedToken !== null && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  try {
    const sa = JSON.parse(serviceAccountJson) as {
      client_email: string;
      private_key: string;
      token_uri?: string;
    };
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claim = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const b64 = (obj: unknown): string =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unsigned = `${b64(header)}.${b64(claim)}`;

    const pem = sa.private_key
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s/g, '');
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der.buffer as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );
    const jwt = `${unsigned}.${btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;

    const res = await fetch(claim.aud, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    if (!res.ok) return null;
    const token = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof token.access_token !== 'string') return null;
    cachedToken = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    };
    return cachedToken.value;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return jsonResponse(500, { error: 'misconfigured' });

  // Only the service key may invoke this — it is a cron target, not an API.
  const auth = req.headers.get('Authorization');
  if (auth !== `Bearer ${serviceKey}`) return jsonResponse(401, { error: 'unauthorized' });

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonResponse(400, { error: 'bad_request' });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // The queue function writes notification_log (including suppressed rows)
  // and hands back only what should actually be sent.
  const { data, error } = await admin.rpc(QUEUE_FN[parsed.data.mode] as string);
  if (error !== null) {
    console.error('queue function failed', error);
    return jsonResponse(500, { error: 'internal' });
  }
  const queued = (data ?? []) as QueuedPush[];
  if (queued.length === 0) return jsonResponse(200, { sent: 0, queued: 0 });

  const projectId = Deno.env.get('FCM_PROJECT_ID');
  const serviceAccount = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON');
  if (!projectId || !serviceAccount) {
    // FCM not configured yet. The notification_log rows still exist, so
    // nothing is lost and the console still shows everything — the push
    // channel is simply dark. Reported, not thrown.
    return jsonResponse(200, { sent: 0, queued: queued.length, fcm: 'unconfigured' });
  }

  const accessToken = await fcmAccessToken(serviceAccount);
  if (accessToken === null) return jsonResponse(500, { error: 'fcm_auth_failed' });

  let sent = 0;
  for (const push of queued) {
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: push.push_token,
              notification: { title: push.title, body: push.body },
              data: Object.fromEntries(
                Object.entries(push.payload ?? {}).map(([k, v]) => [k, String(v)]),
              ),
              android: { priority: 'HIGH' },
            },
          }),
        },
      );
      if (res.ok) {
        sent += 1;
      } else if (res.status === 404 || res.status === 403) {
        // Token is dead (app uninstalled, or the device was rebound and the
        // trigger has not caught up). Clear it so we stop trying.
        await admin
          .from('devices')
          .update({ push_token: null })
          .eq('push_token', push.push_token);
      }
    } catch (err) {
      console.error('fcm send failed', err);
    }
  }

  return jsonResponse(200, { sent, queued: queued.length });
});
