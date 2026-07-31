# /supabase

Supabase backend assets. Managed with the Supabase CLI (`supabase` — not yet
initialised; run `supabase init` when backend work starts, it will add
`config.toml` here).

- `migrations/` — SQL migrations (`supabase migration new <name>`). Postgres +
  PostGIS. Remember /CLAUDE.md rule 8: no "hours worked", "overtime",
  "total_hours", or "duration" strings in the schema.
- `seed.sql` — local development seed data.
- `functions/` — Edge Functions (Deno). One directory per function.
- `tests/` — pgTAP suites (`supabase test db`). `rls_test.sql` proves the RLS
  matrix; it must pass before any policy change merges.
