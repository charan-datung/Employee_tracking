import { z } from 'zod';

const envSchema = z.object({
  VITE_SUPABASE_URL: z.url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(1),
});

const parsed = envSchema.safeParse({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

if (!parsed.success) {
  throw new Error(
    'Missing/invalid Vite env. Copy .env.example to apps/mobile/.env.local ' +
      'and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before building.',
  );
}

export const env = parsed.data;
