import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

// Two clients, on purpose:
//
//   userClient()  — the signed-in console user's session, used to establish
//                   WHO is asking. Runs as `authenticated`, so RLS applies.
//   adminClient() — service_role, SERVER-ONLY, used to read the back-office
//                   queue and to call fix_client_pin (which is granted to
//                   service_role alone). The key never reaches the browser.
//
// Every privileged action verifies the user through userClient() FIRST and
// passes their auth id into the RPC, which re-checks the supervisor tree
// server-side. The service key is a transport detail, never the authority.

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
            // Called from a Server Component: middleware refreshes instead.
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

/** The signed-in console user, or null. Only active supervisors get in. */
export async function currentConsoleUser(): Promise<ConsoleUser | null> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getUser();
  if (data.user === null) return null;

  // Read through the admin client: the console needs the agent row even
  // though console users are not the subject of the mobile RLS policies.
  const admin = adminClient();
  const { data: agent } = await admin
    .from('agents')
    .select('id, full_name, employee_no, role, employment_status')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();

  if (
    agent === null ||
    agent.role !== 'field_supervisor' ||
    agent.employment_status !== 'active'
  ) {
    return null;
  }
  return {
    authUserId: data.user.id,
    agentId: agent.id,
    fullName: agent.full_name,
    employeeNo: agent.employee_no,
  };
}
