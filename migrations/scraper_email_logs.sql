-- ============================================================
-- scraper_email_logs table
-- Run this on EACH tenant's Supabase database
-- Tracks every comparison run: sent, skipped, or failed
-- ============================================================

CREATE TABLE IF NOT EXISTS scraper_email_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      TEXT,
  provider      TEXT,                          -- e.g. 'Command Cloud', 'ConcreteGo'
  status        TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
  skip_reason   TEXT,                          -- reason when status = 'skipped'
  error_message TEXT,                          -- error details when status = 'failed'

  -- Comparison stats
  total_orders        INTEGER DEFAULT 0,
  active_orders       INTEGER DEFAULT 0,
  cancelled_orders    INTEGER DEFAULT 0,
  matched_count       INTEGER DEFAULT 0,
  mismatched_count    INTEGER DEFAULT 0,
  missing_count       INTEGER DEFAULT 0,
  new_in_system_count INTEGER DEFAULT 0,
  excluded_count      INTEGER DEFAULT 0,
  resolved_count      INTEGER DEFAULT 0,

  -- Email recipients
  recipients_to TEXT,
  recipients_cc TEXT,

  -- Performance
  processing_duration_ms INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for admin panel queries (filter by date + status)
CREATE INDEX IF NOT EXISTS idx_scraper_email_logs_created_at
  ON scraper_email_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scraper_email_logs_status
  ON scraper_email_logs (status, created_at DESC);

-- Grant access to Supabase roles (required for PostgREST API access)
GRANT ALL ON scraper_email_logs TO anon;
GRANT ALL ON scraper_email_logs TO authenticated;
GRANT ALL ON scraper_email_logs TO service_role;
