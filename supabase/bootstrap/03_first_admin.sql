-- =============================================================================
-- Bootstrap 3/3 — the first admin
--
-- THE ONLY ACCOUNT CREATED BY HAND. Every other agent is created from
-- /admin/agents in the console, which needs an admin to log in first — this
-- file breaks that circle, once.
--
-- No migration does this on purpose: a migration that ships a login ships a
-- default credential, into every environment, in version control.
--
-- PREREQUISITE — create the auth user first. Only the Auth service can hash a
-- password and write auth.identities, so SQL cannot do this part:
--
--   Dashboard → Authentication → Users → Add user
--     email     dtg-0000@datung.internal
--     password  <something you change at first login>
--     ✅ Auto Confirm User          (there is no mailbox to confirm from)
--
-- Then copy that user's UUID into the placeholder below and run this file.
-- =============================================================================

-- A branch must exist before an agent can reference one. Adjust the name,
-- code and coordinates to your actual head office — the coordinates are the
-- geofence centre for check-in, not decoration.
insert into public.branches (name, code, address, lat, lng)
values ('Head Office', 'HO', 'Las Piñas', 14.4512, 120.9822)
on conflict (code) do nothing;

insert into public.agents
  (auth_user_id, employee_no, full_name, role, branch_id,
   employment_status, hired_at)
values
  ('<uuid-from-the-dashboard>',
   'DTG-0000',
   'System Administrator',
   'admin',
   (select id from public.branches where code = 'HO'),
   'active',
   now())
on conflict (employee_no) do nothing;

-- Verify. Expect exactly one row, role = admin. If you get zero rows the
-- insert hit the conflict clause, which means that employee_no already exists.
select a.employee_no, a.full_name, a.role, b.code as branch
from public.agents a
join public.branches b on b.id = a.branch_id
where a.role = 'admin';

-- Now log into the console. "Agents" and "Branches" appear in the nav only
-- when am_i_admin() returns true — if they are missing, this row did not land
-- against the auth user you actually signed in as.
