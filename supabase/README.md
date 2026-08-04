# /supabase

Supabase backend assets. Managed with the Supabase CLI, which is a standalone
binary and deliberately not an npm dependency (/CLAUDE.md rule 10).

Start at **/docs/SUPABASE.md** — it explains what connects to what.
**/docs/DEPLOY.md** is the checklist once you understand it.

- `config.toml` — CLI configuration. Configures the LOCAL stack and names the
  linked project; nothing here is pushed to a hosted project.
- `migrations/` — SQL migrations (`supabase migration new <name>`). Postgres +
  PostGIS. Remember /CLAUDE.md rule 8: no "hours worked", "overtime",
  "total_hours", or "duration" strings in the schema.
- `bootstrap/` — one-time, idempotent, per-project setup that migrations
  cannot do: the Storage bucket, the cron schedules, and the first admin. Run
  in numbered order after `supabase db push`. Each file explains why it is not
  a migration.
- `seed.sql` — local development seed data.
- `functions/` — Edge Functions (Deno). One directory per function.
- `tests/` — pgTAP suites (`supabase test db`). `rls_test.sql` proves the RLS
  matrix; it must pass before any policy change merges.
