-- Scan History table for mobile QR scanner app
-- Stores per-user scan records with optional ticket/truck data

CREATE TABLE IF NOT EXISTS public.scan_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scan_id text NOT NULL,                    -- client-generated unique ID
  data text NOT NULL,                       -- raw QR payload
  type text NOT NULL DEFAULT 'qr',          -- qr, ean-13, code-128, etc.
  timestamp bigint NOT NULL,                -- client-side epoch ms
  label text,                               -- optional user label
  verified text,                            -- verified, not_found, offline, error
  tk_data jsonb,                            -- decrypted QR data (ticket/truck)
  api_data jsonb,                           -- enriched API data
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, scan_id)
);

-- Index for fast user-scoped queries
CREATE INDEX IF NOT EXISTS idx_scan_history_user_id ON public.scan_history(user_id);
CREATE INDEX IF NOT EXISTS idx_scan_history_user_timestamp ON public.scan_history(user_id, timestamp DESC);
