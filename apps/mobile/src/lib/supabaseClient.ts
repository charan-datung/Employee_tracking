import { createClient } from '@supabase/supabase-js';
import { env } from './env';
import { kvStore } from './kvStore';

// The session persists through kvStore (see kvStore.ts for the encryption
// status of the backing store — this is the single swap point).
export const supabase = createClient(
  env.VITE_SUPABASE_URL,
  env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storage: {
        getItem: (key: string) => kvStore.get(key),
        setItem: (key: string, value: string) => kvStore.set(key, value),
        removeItem: (key: string) => kvStore.remove(key),
      },
      persistSession: true,
      autoRefreshToken: true,
      // No OAuth redirects in this app — never parse tokens out of URLs.
      detectSessionInUrl: false,
    },
  },
);
