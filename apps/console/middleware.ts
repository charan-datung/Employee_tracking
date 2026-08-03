import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Layer 1 of console access control (see 20260731070000_console_and_notifications.sql).
//
// This runs before any page renders and rejects anyone who is not an active
// field supervisor — including a perfectly valid AGENT token. Agent
// credentials must not open the console, and the check that enforces that is
// my_console_access(), evaluated in the database, not a role string read from
// the JWT (which the client controls the storage of).
//
// This also refreshes the Supabase session cookie, which Server Components
// cannot do.

const PUBLIC_PATHS = ['/login', '/auth'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (not getSession()) — it revalidates against the auth server, so
  // a revoked or expired token cannot walk in on a stale cookie.
  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (data.user === null) {
    if (isPublic) return response;
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    return NextResponse.redirect(login);
  }

  // Signed in — but is this a supervisor? The database decides.
  const { data: allowed } = await supabase.rpc('my_console_access');
  if (allowed !== true) {
    // Deliberately a dead end rather than a redirect loop: an agent who
    // somehow reached a console URL gets told plainly, and their session is
    // left alone so the mobile app keeps working.
    if (path === '/no-access') return response;
    const denied = request.nextUrl.clone();
    denied.pathname = '/no-access';
    return NextResponse.redirect(denied);
  }

  if (isPublic) {
    const home = request.nextUrl.clone();
    home.pathname = '/';
    return NextResponse.redirect(home);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg)$).*)'],
};
