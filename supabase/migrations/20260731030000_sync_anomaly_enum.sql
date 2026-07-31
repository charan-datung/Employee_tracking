-- sync_anomaly: raised when the mobile outbox hits a permanent sync failure
-- (a 4xx the client may not retry) or storage pressure. Data is NEVER dropped
-- silently — the row stays on the device and this flag is how the console
-- finds out.
--
-- Kept as its own migration: ALTER TYPE ... ADD VALUE may run inside a
-- transaction, but the new value cannot be REFERENCED in the same
-- transaction, and the next migration's policy references it.
alter type public.integrity_flag_type add value 'sync_anomaly';
