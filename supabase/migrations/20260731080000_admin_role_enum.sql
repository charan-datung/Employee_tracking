-- Adds the 'admin' role.
--
-- Until now every console user was a field_supervisor, which works for
-- reviewing sessions but cannot onboard anyone: creating agents, branches and
-- client assignments is a different job with a different blast radius. A
-- supervisor should not be able to mint accounts.
--
-- Its own migration because ALTER TYPE ... ADD VALUE cannot be referenced in
-- the same transaction that adds it, and the next migration references it.
alter type public.agent_role add value 'admin';
