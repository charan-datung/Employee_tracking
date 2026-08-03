import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

// TWO CLIENTS, AND THE DEFAULT MATTERS.
//
//   userClient()  — the signed-in supervisor's own session. THIS IS THE
//                   DEFAULT FOR ALL READS. Requests run as `authenticated`,
//                   so the *_select_reports RLS policies decide what comes
//                   back. A supervisor sees their reporting tree because the
//                   database says so, not because a WHERE clause remembered
//                   to filter. An agent's token returns their own rows only,
//                   and no console page renders those.
//
//   adminClient() — service_role, SERVER-ONLY, reserved for the few calls RLS
//                   cannot express: SECURITY DEFINER RPCs that re-check
//                   authority themselves (fix_client_pin,
//                   approve_device_rebind_tx, evaluate_session_integrity).
//                   Never used to "just read something" — that would silently
//                   bypass the tree.
//
// If you find yourself reaching for adminClient() to render a page, the RLS
// policy is missing and that is the bug to fix.

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

function env() {
  const parsed = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!parsed.success) {
    throw new Error(
      'Console env missing. Set NEXT_PUBLIC_SUPABASE_URL, ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return parsed.data;
}

export async function userClient() {
  const store = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  return createServerClient(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              store.set(name, value, options);
            }
          } catch {
            // Called from a Server Component; middleware handles the refresh.
          }
        },
      },
    },
  );
}

export function adminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface ConsoleUser {
  authUserId: string;
  agentId: string;
  fullName: string;
  employeeNo: string;
}

/**
 * The signed-in console user, or null.
 *
 * Access is decided by has_console_access() in the DATABASE — a SECURITY
 * DEFINER function the browser cannot influence — not by reading a role
 * column here and trusting it.
 */
export async function currentConsoleUser(): Promise<ConsoleUser | null> {
  const supabase = await userClient();
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user === null) return null;

  const { data: allowed } = await supabase.rpc('my_console_access');
  if (allowed !== true) return null;

  // RLS agents_select_self covers this read; no service key required.
  const { data: agent } = await supabase
    .from('agents')
    .select('id, full_name, employee_no')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (agent === null) return null;

  return {
    authUserId: userData.user.id,
    agentId: agent.id,
    fullName: agent.full_name,
    employeeNo: agent.employee_no,
  };
}

/** Page guard: returns the user or throws the redirect. */
export async function requireConsoleUser(): Promise<ConsoleUser> {
  const user = await currentConsoleUser();
  // redirect() throws, so TypeScript narrows `user` for every caller.
  if (user === null) redirect('/login');
  return user;
}
