-- Drop the foreign key constraint on scan_history.user_id
-- The user_id comes from central auth JWT and may not exist in public.users.
-- This constraint causes INSERT failures for users authenticated via central auth.

ALTER TABLE public.scan_history
  DROP CONSTRAINT IF EXISTS scan_history_user_id_fkey;
