// Shared HTTP plumbing for edge functions. The mobile app's WebView origin is
// https://localhost (Capacitor androidScheme), so CORS must be answered.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function preflightResponse(): Response {
  return new Response('ok', { headers: corsHeaders });
}
