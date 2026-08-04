-- =============================================================================
-- Bootstrap 1/3 — photo storage
--
-- Run once per project, AFTER `supabase db push`, in the SQL editor (or via
-- `npm run db:bootstrap` against a local stack). Idempotent: safe to re-run.
--
-- This is not a migration on purpose. `storage.buckets` and `storage.objects`
-- belong to the Storage service, not to our schema; putting them in
-- migrations/ would mean `db reset` recreating another service's state and
-- would make the migration chain fail on any project where Storage is
-- provisioned differently.
-- =============================================================================

-- PRIVATE bucket. Nothing about a field agent's selfie should be reachable by
-- URL guess. The console reads photos through short-lived signed URLs minted
-- server-side (createSignedUrls, 600s) only after RLS has already authorised
-- the session read — see apps/console/app/agent/[agentId]/session/[sessionId].
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('field-photos', 'field-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Postgres has no CREATE POLICY IF NOT EXISTS, so drop-then-create is the only
-- idempotent form.
drop policy if exists field_photos_insert_own on storage.objects;

-- Agents may upload ONLY into their own folder. savePhotoLocal() generates
-- `<agent_id>/<photo_local_id>.jpg` (apps/mobile/src/services/sync/photos.ts),
-- so the first path segment is the agent's own id and this check binds the
-- object namespace to the authenticated identity. Without it any agent could
-- overwrite another agent's check-in selfie, which is the cheapest possible
-- attack on the whole verification story.
create policy field_photos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'field-photos'
    and (storage.foldername(name))[1] = (select (public.current_agent()).id)::text
  );

-- No SELECT, UPDATE or DELETE policy is created, and that is deliberate:
--   * SELECT — agents never re-read photos; the console uses signed URLs.
--   * UPDATE — an object that can be replaced is not evidence.
--   * DELETE — nothing in this system deletes evidence (mirrors the schema's
--              "DELETE: nothing. Ever." rule).
-- RLS on storage.objects denies by default, so their absence IS the policy.
